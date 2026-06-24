import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Mail,
  Package,
  Box,
  Truck,
  Zap,
  Clock,
  MapPin,
  Phone,
  CheckCircle2,
  AlertTriangle,
  Pencil,
  Route,
  Loader2,
  Search,
  MessageCircle,
  PhoneCall,
} from "lucide-react";

const WA_NUMBER = "972549252094"; // 054-9252094 in international format
const CALL_NUMBER = "0549252094";

function buildWaMessage(order, sizeLabel, urgencyLabel) {
  const src = order.distanceSource === "auto" ? "(מחושב אוטומטית)" : "(ידני)";
  return (
    `🚚 *הזמנת שליחות חדשה – מסלול*\n` +
    `מספר הזמנה: ${order.id}\n\n` +
    `📦 גודל: ${sizeLabel}\n` +
    `⚡ דחיפות: ${urgencyLabel}\n\n` +
    `📍 *איסוף:* ${order.from}${order.phoneFrom ? `\n☎️ ${order.phoneFrom}` : ""}\n` +
    `🏁 *מסירה:* ${order.to}${order.phoneTo ? `\n☎️ ${order.phoneTo}` : ""}\n\n` +
    `📏 מרחק: ${order.km} ק״מ ${src}\n` +
    `💰 מחיר: ₪${order.price}` +
    (order.notes ? `\n\n📝 הערות: ${order.notes}` : "")
  );
}

/* ---------------------------------------------------------
   Pricing — exactly per spec:
   base 60 + 20/km for first 8km + 10/km beyond 8km
--------------------------------------------------------- */
function calcPrice(km, multiplier = 1) {
  const base = 40;
  // First km = ₪10, each additional km is 8% cheaper than the previous
  const FIRST_KM_RATE = 10;
  const DISCOUNT = 0.08;
  const steps = [];
  let rate = FIRST_KM_RATE;
  const fullKms = Math.floor(km);
  const fraction = km - fullKms;
  for (let i = 0; i < fullKms; i++) {
    steps.push({ km: 1, rate });
    rate = rate * (1 - DISCOUNT);
  }
  if (fraction > 0) steps.push({ km: fraction, rate });
  const distanceCost = steps.reduce((sum, s) => sum + s.km * s.rate, 0);
  return {
    base,
    distanceCost,
    steps,           // for breakdown display
    multiplier,
    total: Math.round((base + distanceCost) * multiplier),
  };
}

/* Smoothly animates a displayed number toward a target value. */
function useAnimatedNumber(target, duration = 350) {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  const startRef = useRef(null);
  const rafRef = useRef(null);

  useEffect(() => {
    fromRef.current = value;
    startRef.current = null;
    cancelAnimationFrame(rafRef.current);

    const tick = (ts) => {
      if (startRef.current === null) startRef.current = ts;
      const progress = Math.min((ts - startRef.current) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = fromRef.current + (target - fromRef.current) * eased;
      setValue(next);
      if (progress < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  return value;
}

/* Ask Claude (with live web search) to validate the two addresses and
   work out a realistic driving distance/duration between them — this
   runs through Anthropic's API, which is reachable from inside the
   artifact, unlike a direct call to a maps provider. */
async function lookupRoute(fromAddr, toAddr) {
  const prompt =
    `Two addresses, both expected to be real locations in Israel:\n` +
    `From: "${fromAddr}"\n` +
    `To: "${toAddr}"\n\n` +
    `Use web search to confirm both are real, specific locations and to find the realistic ` +
    `driving distance in kilometers and typical driving duration in minutes between them ` +
    `(e.g. via Google Maps or Waze results). Respond with ONLY a raw JSON object, no markdown, ` +
    `no code fences, no explanation, exactly in this shape:\n` +
    `{"valid": true, "from_normalized": "short address", "to_normalized": "short address", "distance_km": 12.3, "duration_min": 18, "reason": ""}\n` +
    `If either address cannot be confidently identified as a real, specific location, respond with:\n` +
    `{"valid": false, "from_normalized": "", "to_normalized": "", "distance_km": 0, "duration_min": 0, "reason": "short reason in Hebrew"}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || "API error");

  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const cleaned = text.replace(/```json|```/g, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  const jsonStr = match ? match[0] : cleaned;
  return JSON.parse(jsonStr);
}

const SIZES = [
  { id: "envelope", label: "מעטפה", hint: "מסמכים, מעטפה דקה", Icon: Mail },
  { id: "small", label: "קטן", hint: "עד תיק קטן", Icon: Package },
  { id: "medium", label: "בינוני", hint: "קופסה / שקית גדולה", Icon: Box },
  { id: "large", label: "גדול (רכב)", hint: "דורש רכב", Icon: Truck },
];

const URGENCIES = [
  { id: "express", label: "אקספרס", hint: "תוך שעתיים", Icon: Zap, color: "#FF6B6B", multiplier: 1.5 },
  { id: "urgent",  label: "דחוף",    hint: "תוך 4 שעות",  Icon: Zap, color: "var(--lime)", multiplier: 1.0 },
  { id: "regular", label: "רגיל",    hint: "1–2 ימי עסקים", Icon: Clock, color: "var(--teal)", multiplier: 0.7 },
];

const KM_PRESETS = [2, 5, 8, 12, 20, 30];

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "עכשיו";
  if (mins < 60) return `לפני ${mins} דק'`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `לפני ${hrs} ש'`;
  const days = Math.round(hrs / 24);
  return `לפני ${days} י'`;
}

export default function App() {
  const [fromQuery, setFromQuery] = useState("");
  const [toQuery, setToQuery] = useState("");
  const [phoneFrom, setPhoneFrom] = useState("");
  const [phoneTo, setPhoneTo] = useState("");
  const [notes, setNotes] = useState("");
  const [size, setSize] = useState(null);
  const [urgency, setUrgency] = useState(null);

  const [manualKm, setManualKm] = useState(5);
  const [useAuto, setUseAuto] = useState(true);
  const [autoKm, setAutoKm] = useState(null);
  const [autoMinutes, setAutoMinutes] = useState(null);

  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");

  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 4000);
    return () => clearTimeout(t);
  }, [successMsg]);

  const invalidateAuto = () => {
    setAutoKm(null);
    setAutoMinutes(null);
    setCheckError("");
  };

  const handleCheckRoute = useCallback(async () => {
    if (!fromQuery.trim() || !toQuery.trim()) {
      setCheckError("נא להזין כתובת איסוף וכתובת מסירה לפני הבדיקה");
      return;
    }
    setChecking(true);
    setCheckError("");
    try {
      const result = await lookupRoute(fromQuery.trim(), toQuery.trim());
      if (!result.valid) {
        setAutoKm(null);
        setAutoMinutes(null);
        setUseAuto(false);
        setCheckError(result.reason || "לא הצלחנו לאתר את הכתובות. בדקו איות ונסו שוב, או הזינו מרחק ידנית.");
      } else {
        setAutoKm(Number(result.distance_km) || 0);
        setAutoMinutes(Number(result.duration_min) || 0);
        setUseAuto(true);
        if (result.from_normalized) setFromQuery(result.from_normalized);
        if (result.to_normalized) setToQuery(result.to_normalized);
      }
    } catch (e) {
      setAutoKm(null);
      setAutoMinutes(null);
      setUseAuto(false);
      setCheckError("הבדיקה נכשלה (שגיאת רשת או תגובה לא תקינה). ניתן לנסות שוב או להזין מרחק ידנית.");
    } finally {
      setChecking(false);
    }
  }, [fromQuery, toQuery]);

  const haveAuto = autoKm !== null && useAuto;
  const effectiveKm = haveAuto ? autoKm : manualKm;

  const selectedSize = SIZES.find((s) => s.id === size);
  const selectedUrgency = URGENCIES.find((u) => u.id === urgency);
  const urgencyMultiplier = selectedUrgency ? selectedUrgency.multiplier : 1;
  const price = calcPrice(effectiveKm, urgencyMultiplier);
  const animatedTotal = useAnimatedNumber(price.total);
  const trackColor = selectedUrgency ? selectedUrgency.color : "var(--border-strong)";
  const VehicleIcon = selectedSize ? selectedSize.Icon : Package;
  const travelDuration = urgency === "urgent" ? 1.6 : 3.2;

  const handleValidate = useCallback(() => {
    if (!fromQuery.trim() || !toQuery.trim()) { setError("נא להזין כתובת איסוף וכתובת מסירה"); return null; }
    if (!size) { setError("נא לבחור גודל חבילה"); return null; }
    if (!urgency) { setError("נא לבחור רמת דחיפות"); return null; }
    if (!phoneFrom.trim()) { setError("נא להזין טלפון איש קשר באיסוף"); return null; }
    if (!phoneTo.trim()) { setError("נא להזין טלפון איש קשר במסירה"); return null; }
    setError("");

    const order = {
      id: "ORD-" + Date.now().toString(36).toUpperCase(),
      from: fromQuery.trim(),
      to: toQuery.trim(),
      phoneFrom: phoneFrom.trim(),
      phoneTo: phoneTo.trim(),
      notes: notes.trim(),
      size,
      urgency,
      km: Math.round(effectiveKm * 10) / 10,
      distanceSource: haveAuto ? "auto" : "manual",
      price: price.total,
      createdAt: new Date().toISOString(),
    };

    const sizeLabel = SIZES.find((s) => s.id === order.size)?.label || order.size;
    const urgencyLabel = URGENCIES.find((u) => u.id === order.urgency)?.label || order.urgency;
    const waMsg = buildWaMessage(order, sizeLabel, urgencyLabel);
    const url = "https://wa.me/" + WA_NUMBER + "?text=" + encodeURIComponent(waMsg);

    return url;
  }, [fromQuery, toQuery, phoneFrom, phoneTo, notes, size, urgency, effectiveKm, haveAuto, price.total]);

  return (
    <div className="app-root" dir="rtl">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Rubik:wght@500;700;800&family=Heebo:wght@400;500;600;700&family=JetBrains+Mono:wght@500;700&display=swap');

        :root{
          --bg:#14171C;
          --surface:#1C2027;
          --surface-2:#242A33;
          --border:#323943;
          --border-strong:#454C57;
          --text:#F3F1EA;
          --text-muted:#8B919C;
          --lime:#D7FF3A;
          --teal:#4FB6C9;
          --danger:#FF6B6B;
        }
        *{ box-sizing:border-box; }
        .app-root{
          font-family:'Heebo', sans-serif;
          background:var(--bg);
          color:var(--text);
          min-height:100vh;
          padding:20px 14px 48px;
        }
        .f-display{ font-family:'Rubik', sans-serif; }
        .f-mono{ font-family:'JetBrains Mono', monospace; }

        .wrap{ max-width:430px; margin:0 auto; display:flex; flex-direction:column; gap:16px; }

        .brand{ display:flex; align-items:center; justify-content:space-between; }
        .brand-mark{ display:flex; align-items:center; gap:8px; }
        .brand-logo{ width:34px; height:34px; border-radius:10px; background:var(--lime); display:flex; align-items:center; justify-content:center; color:#10130A; flex-shrink:0; }
        .brand-title{ font-size:20px; font-weight:800; letter-spacing:-0.02em; }
        .brand-sub{ font-size:11px; color:var(--text-muted); margin-top:1px; }

        .card{ background:var(--surface); border:1px solid var(--border); border-radius:18px; padding:16px; }

        .route-card{ padding:16px 14px 20px; }
        .route-addr-row{ display:flex; justify-content:space-between; gap:10px; }
        .route-addr{ flex:1; min-width:0; }
        .route-addr.end{ text-align:left; }
        .route-label{ font-size:10.5px; color:var(--text-muted); text-transform:uppercase; letter-spacing:.04em; }
        .route-value{ font-size:13px; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .route-value.placeholder{ color:var(--text-muted); }

        .route-track{ position:relative; height:2px; margin:26px 4px 4px;
          background-image: repeating-linear-gradient(to right, var(--track-color) 0 8px, transparent 8px 16px); }
        .pin-dot{ position:absolute; top:-4px; width:10px; height:10px; border-radius:50%; background:var(--track-color); }
        .vehicle-wrap{ position:absolute; top:-16px; inset-inline-start:0%; }
        .vehicle-wrap.moving{ animation: travel var(--dur) linear infinite; }
        @keyframes travel{ from{ inset-inline-start:0%; } to{ inset-inline-start: calc(100% - 26px); } }

        .section-title{ font-size:13px; font-weight:700; color:var(--text-muted); margin-bottom:10px; display:flex; align-items:center; justify-content:space-between; }

        .field{ margin-bottom:10px; }
        .field:last-child{ margin-bottom:0; }
        .field-label{ font-size:12px; color:var(--text-muted); margin-bottom:5px; display:block; }
        .input-row{ display:flex; align-items:center; gap:8px; background:var(--surface-2); border:1px solid var(--border); border-radius:12px; padding:0 12px; transition:border-color .15s; }
        .input-row:focus-within{ border-color:var(--teal); }
        .input-row input{ flex:1; background:transparent; border:none; outline:none; color:var(--text); font-family:'Heebo',sans-serif; font-size:14px; padding:11px 0; min-width:0; }
        .input-row input::placeholder{ color:var(--text-muted); }
        .input-row svg{ flex-shrink:0; color:var(--text-muted); }
        .spin{ animation: spin 0.8s linear infinite; }
        @keyframes spin{ to{ transform:rotate(360deg); } }

        textarea.plain{ width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:12px; color:var(--text); padding:10px 12px; font-family:'Heebo',sans-serif; font-size:14px; outline:none; resize:none; }
        textarea.plain:focus{ border-color:var(--teal); }
        textarea.plain::placeholder{ color:var(--text-muted); }

        .grid-4{ display:grid; grid-template-columns:repeat(4,1fr); gap:8px; }
        .grid-2{ display:grid; grid-template-columns:repeat(2,1fr); gap:8px; }
        .grid-3{ display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }

        .tile{ background:var(--surface-2); border:1.5px solid var(--border); border-radius:14px; padding:10px 6px 12px; display:flex; flex-direction:column; align-items:center; gap:6px; cursor:pointer; transition: border-color .15s, background .15s; text-align:center; }
        .tile:hover{ border-color:var(--border-strong); }
        .tile-label{ font-size:12px; font-weight:600; }
        .tile-hint{ font-size:9.5px; color:var(--text-muted); line-height:1.3; }
        .tile.sel-express{ border-color:var(--danger); background:rgba(255,107,107,0.08); }
        .tile.sel-urgent{ border-color:var(--lime); background:rgba(215,255,58,0.08); }
        .tile.sel-regular{ border-color:var(--teal); background:rgba(79,182,201,0.08); }
        .tile.sel-pkg{ border-color:var(--text); background:var(--surface); }

        .km-display{ display:flex; align-items:baseline; justify-content:center; gap:4px; margin:4px 0 2px; }
        .km-num{ font-size:30px; font-weight:700; }
        .km-unit{ font-size:13px; color:var(--text-muted); }
        .km-caption{ text-align:center; font-size:11.5px; color:var(--text-muted); margin-bottom:10px; }
        .km-caption.auto{ color:var(--lime); }

        input[type="range"]{ width:100%; accent-color:var(--lime); height:4px; }

        .chip-row{ display:flex; gap:6px; margin-top:10px; flex-wrap:wrap; }
        .chip{ background:var(--surface-2); border:1px solid var(--border); color:var(--text-muted); font-size:11px; border-radius:999px; padding:5px 11px; cursor:pointer; font-family:'JetBrains Mono',monospace; }
        .chip.active{ border-color:var(--teal); color:var(--text); }

        .tip{ font-size:11px; color:var(--text-muted); margin-top:10px; line-height:1.5; }
        .link-btn{ background:none; border:none; color:var(--teal); font-size:11.5px; cursor:pointer; display:flex; align-items:center; gap:4px; font-weight:600; padding:0; }

        .btn-secondary{ background:var(--surface-2); border:1px solid var(--border-strong); color:var(--text); font-weight:600; border-radius:12px; padding:11px; font-size:13px; cursor:pointer; width:100%; display:flex; align-items:center; justify-content:center; gap:8px; margin-top:8px; transition: border-color .15s, opacity .15s; }
        .btn-secondary:hover{ border-color:var(--teal); }
        .btn-secondary:disabled{ opacity:.5; cursor:not-allowed; }
        .btn-secondary:active{ transform:scale(0.98); }

        .price-row{ display:flex; justify-content:space-between; align-items:baseline; padding:5px 0; font-size:13px; }
        .price-row .lbl{ color:var(--text-muted); }
        .price-row .val{ font-weight:600; }
        .price-divider{ height:1px; background:var(--border); margin:8px 0; }
        .price-total-row{ display:flex; justify-content:space-between; align-items:baseline; padding-top:2px; }
        .price-total-lbl{ font-size:14px; font-weight:700; }
        .price-total-val{ font-size:30px; font-weight:700; color:var(--lime); }

        .btn-primary{ background:var(--lime); color:#10130A; font-weight:700; border:none; border-radius:14px; padding:15px; font-size:15px; cursor:pointer; width:100%; display:flex; align-items:center; justify-content:center; gap:8px; transition: transform .1s, opacity .15s; }
        .btn-primary:active{ transform:scale(0.98); }
        .btn-primary:disabled{ opacity:0.45; cursor:not-allowed; }

        .error-box{ background:rgba(255,107,107,0.1); border:1px solid var(--danger); color:#FFB3B3; font-size:12.5px; border-radius:10px; padding:9px 12px; display:flex; align-items:center; gap:7px; }
        .success-box{ background:rgba(215,255,58,0.1); border:1px solid var(--lime); color:var(--lime); font-size:13px; border-radius:12px; padding:11px 14px; display:flex; align-items:center; gap:8px; font-weight:600; }

        .order-row{ border-bottom:1px solid var(--border); padding:11px 0; display:flex; align-items:flex-start; gap:10px; }
        .order-row:last-child{ border-bottom:none; }
        .order-icon{ width:32px; height:32px; border-radius:9px; background:var(--surface-2); display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .order-main{ flex:1; min-width:0; }
        .order-route{ font-size:12.5px; display:flex; align-items:center; gap:5px; overflow:hidden; }
        .order-route span{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:38%; }
        .order-meta{ font-size:11px; color:var(--text-muted); margin-top:3px; display:flex; gap:8px; flex-wrap:wrap; }
        .order-price{ font-family:'JetBrains Mono',monospace; font-weight:700; font-size:14px; white-space:nowrap; }
        .order-del{ background:none; border:none; color:var(--text-muted); cursor:pointer; padding:4px; flex-shrink:0; }
        .order-del:hover{ color:var(--danger); }
        .badge{ font-size:10px; border-radius:999px; padding:2px 8px; display:inline-flex; align-items:center; gap:4px; }
        .badge-urgent{ background:rgba(215,255,58,0.12); color:var(--lime); }
        .badge-regular{ background:rgba(79,182,201,0.12); color:var(--teal); }

        .empty-state{ text-align:center; padding:18px 8px; color:var(--text-muted); font-size:13px; }

        .contact-bar{ display:flex; align-items:center; gap:8px; background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:10px 14px; }
        .contact-btn{ display:flex; align-items:center; gap:6px; border-radius:10px; padding:7px 13px; font-size:13px; font-weight:600; text-decoration:none; transition: opacity .15s; flex-shrink:0; }
        .contact-btn:active{ opacity:.75; }
        .contact-call{ background:rgba(79,182,201,0.15); color:var(--teal); border:1px solid rgba(79,182,201,0.3); }
        .contact-wa{ background:rgba(37,211,102,0.12); color:#25D366; border:1px solid rgba(37,211,102,0.3); }
        .contact-num{ font-family:'JetBrains Mono',monospace; font-size:12px; color:var(--text-muted); margin-right:auto; direction:ltr; }
      `}</style>

      <div className="wrap">
        {/* Brand */}
        <div className="brand">
          <div className="brand-mark">
            <div className="brand-logo">
              <Route size={19} strokeWidth={2.5} />
            </div>
            <div>
              <div className="brand-title f-display">מסלול</div>
              <div className="brand-sub">שליחויות פרטיות, ישר ליעד</div>
            </div>
          </div>
        </div>

        {/* Quick contact bar */}
        <div className="contact-bar">
          <a href={`tel:${CALL_NUMBER}`} className="contact-btn contact-call">
            <PhoneCall size={15} />
            <span>חיוג מהיר</span>
          </a>
          <a
            href={`https://wa.me/${WA_NUMBER}`}
            target="_blank"
            rel="noopener noreferrer"
            className="contact-btn contact-wa"
          >
            <MessageCircle size={15} />
            <span>WhatsApp</span>
          </a>
          <span className="contact-num">{CALL_NUMBER}</span>
        </div>

        {successMsg && (
          <div className="success-box">
            <CheckCircle2 size={16} />
            {successMsg}
          </div>
        )}

        {/* Route hero */}
        <div className="card route-card">
          <div className="route-addr-row">
            <div className="route-addr">
              <div className="route-label f-mono">איסוף</div>
              <div className={`route-value ${!fromQuery ? "placeholder" : ""}`}>
                {fromQuery || "כתובת מוצא"}
              </div>
            </div>
            <div className="route-addr end">
              <div className="route-label f-mono">מסירה</div>
              <div className={`route-value ${!toQuery ? "placeholder" : ""}`}>
                {toQuery || "כתובת יעד"}
              </div>
            </div>
          </div>

          <div className="route-track" style={{ "--track-color": trackColor }}>
            <div className="pin-dot" style={{ insetInlineStart: 0 }} />
            <div className="pin-dot" style={{ insetInlineEnd: 0 }} />
            <div
              className={`vehicle-wrap ${urgency ? "moving" : ""}`}
              style={{ "--dur": `${travelDuration}s`, color: trackColor }}
            >
              <div style={{ transform: "scaleX(-1)" }}>
                <VehicleIcon size={24} strokeWidth={2.2} />
              </div>
            </div>
          </div>
        </div>

        {/* Addresses */}
        <div className="card">
          <div className="section-title"><span>מאיפה לאיפה</span></div>

          <div className="field">
            <span className="field-label">כתובת איסוף</span>
            <div className="input-row">
              <MapPin size={16} />
              <input
                placeholder="רחוב, מספר, עיר"
                value={fromQuery}
                onChange={(e) => {
                  setFromQuery(e.target.value);
                  invalidateAuto();
                }}
              />
              {haveAuto && <CheckCircle2 size={15} color="var(--lime)" />}
            </div>
          </div>

          <div className="field">
            <span className="field-label">כתובת מסירה</span>
            <div className="input-row">
              <MapPin size={16} />
              <input
                placeholder="רחוב, מספר, עיר"
                value={toQuery}
                onChange={(e) => {
                  setToQuery(e.target.value);
                  invalidateAuto();
                }}
              />
              {haveAuto && <CheckCircle2 size={15} color="var(--lime)" />}
            </div>
          </div>

          <button className="btn-secondary" onClick={handleCheckRoute} disabled={checking}>
            {checking ? <Loader2 size={15} className="spin" /> : <Search size={15} />}
            {checking ? "מחפש מסלול ומאמת כתובות..." : "בדוק כתובות וחשב מרחק נסיעה"}
          </button>

          {checkError && (
            <div className="error-box" style={{ marginTop: 8 }}>
              <AlertTriangle size={13} /> {checkError}
            </div>
          )}
          {haveAuto && (
            <div className="success-box" style={{ marginTop: 8, fontSize: 12 }}>
              <CheckCircle2 size={14} /> כתובות אומתו · {autoKm.toFixed(1)} ק״מ נסיעה · כ‑{Math.round(autoMinutes)} דק׳
            </div>
          )}

          <div className="grid-2" style={{ marginTop: 10 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <span className="field-label">טלפון איש קשר באיסוף *</span>
              <div className="input-row">
                <Phone size={16} />
                <input
                  placeholder="050-1234567"
                  value={phoneFrom}
                  onChange={(e) => setPhoneFrom(e.target.value)}
                  inputMode="tel"
                />
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <span className="field-label">טלפון איש קשר במסירה *</span>
              <div className="input-row">
                <Phone size={16} />
                <input
                  placeholder="050-1234567"
                  value={phoneTo}
                  onChange={(e) => setPhoneTo(e.target.value)}
                  inputMode="tel"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Package size */}
        <div className="card">
          <div className="section-title"><span>גודל החבילה</span></div>
          <div className="grid-4">
            {SIZES.map(({ id, label, hint, Icon }) => {
              const sel = size === id;
              return (
                <div key={id} className={`tile ${sel ? "sel-pkg" : ""}`} onClick={() => setSize(id)}>
                  <Icon size={20} color={sel ? "var(--text)" : "var(--text-muted)"} />
                  <div className="tile-label">{label}</div>
                  <div className="tile-hint">{hint}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Urgency */}
        <div className="card">
          <div className="section-title"><span>רמת דחיפות</span></div>
          <div className="grid-3">
            {URGENCIES.map(({ id, label, hint, Icon, color }) => {
              const sel = urgency === id;
              return (
                <div
                  key={id}
                  className={`tile ${sel ? (id === "express" ? "sel-express" : id === "urgent" ? "sel-urgent" : "sel-regular") : ""}`}
                  onClick={() => setUrgency(id)}
                >
                  <Icon size={20} color={sel ? color : "var(--text-muted)"} />
                  <div className="tile-label">{label}</div>
                  <div className="tile-hint">{hint}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Distance */}
        <div className="card">
          <div className="section-title">
            <span>מרחק נסיעה</span>
            {autoKm !== null && (
              <button className="link-btn" onClick={() => setUseAuto(!useAuto)}>
                <Pencil size={11} />
                {useAuto ? "התאמה ידנית" : "חזרה לאוטומטי"}
              </button>
            )}
          </div>

          <div className="km-display">
            <span className="km-num f-mono">{effectiveKm.toFixed(1)}</span>
            <span className="km-unit">ק״מ</span>
          </div>
          <div className={`km-caption ${haveAuto ? "auto" : ""}`}>
            {haveAuto
              ? `מרחק נסיעה בפועל${autoMinutes ? ` · כ-${Math.round(autoMinutes)} דק' נהיגה` : ""}`
              : "מרחק ידני"}
          </div>

          {!haveAuto && (
            <>
              <input
                type="range"
                min="0.5"
                max="40"
                step="0.5"
                value={manualKm}
                onChange={(e) => setManualKm(parseFloat(e.target.value))}
              />
              <div className="chip-row">
                {KM_PRESETS.map((k) => (
                  <button
                    key={k}
                    className={`chip ${manualKm === k ? "active" : ""}`}
                    onClick={() => setManualKm(k)}
                  >
                    {k} ק״מ
                  </button>
                ))}
              </div>
              <div className="tip">
                כדי לחשב מרחק אוטומטית — מלאו כתובת איסוף ומסירה למעלה ולחצו על "בדוק כתובות וחשב מרחק נסיעה".
              </div>
            </>
          )}
        </div>

        {/* Price */}
        <div className="card">
          <div className="section-title"><span>מחיר</span></div>
          <div className="price-row">
            <span className="lbl">מחיר בסיס</span>
            <span className="val f-mono">₪{price.base}</span>
          </div>
          {price.multiplier !== 1 && (
            <div className="price-row">
              <span className="lbl" style={{color: price.multiplier > 1 ? "var(--danger)" : "var(--teal)"}}>
                {price.multiplier > 1 ? `תוספת דחיפות ×${price.multiplier}` : `הנחת רגיל −${Math.round((1 - price.multiplier) * 100)}%`}
              </span>
              <span className="val f-mono" style={{color: price.multiplier > 1 ? "var(--danger)" : "var(--teal)"}}>
                {price.multiplier > 1 ? `+${Math.round((price.base + price.distanceCost) * (price.multiplier - 1))}₪` : `−${Math.round((price.base + price.distanceCost) * (1 - price.multiplier))}₪`}
              </span>
            </div>
          )}
          {price.steps.slice(0, 5).map((s, i) => (
            <div className="price-row" key={i}>
              <span className="lbl">ק״מ {i + 1} × ₪{s.rate.toFixed(2)}</span>
              <span className="val f-mono">₪{(s.km * s.rate).toFixed(2)}</span>
            </div>
          ))}
          {price.steps.length > 5 && (
            <div className="price-row">
              <span className="lbl">ק״מ 6–{price.steps.length} (יורד 8% בכל ק״מ)</span>
              <span className="val f-mono">₪{price.steps.slice(5).reduce((s,x) => s + x.km * x.rate, 0).toFixed(2)}</span>
            </div>
          )}
          <div className="price-divider" />
          <div className="price-total-row">
            <span className="price-total-lbl">סה״כ לתשלום</span>
            <span className="price-total-val f-mono">₪{Math.round(animatedTotal)}</span>
          </div>
        </div>

        {/* Notes */}
        <div className="card">
          <div className="section-title"><span>הערות לשליח (לא חובה)</span></div>
          <textarea
            className="plain"
            rows={2}
            placeholder="קוד לבניין, קומה, פרטים נוספים..."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {error && (
          <div className="error-box">
            <AlertTriangle size={14} /> {error}
          </div>
        )}

        {(() => {
          const waUrl = error ? null : null; // placeholder to keep block
          return (
            <a
              href={"#"}
              className="btn-primary"
              style={{textDecoration:"none"}}
              onClick={(e) => {
                e.preventDefault();
                const url = handleValidate();
                if (url) {
                  const a = document.createElement("a");
                  a.href = url;
                  a.target = "_blank";
                  a.rel = "noopener noreferrer";
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                  setFromQuery(""); setToQuery(""); setFromSelected(null); setToSelected(null);
                  setPhoneFrom(""); setPhoneTo(""); setNotes("");
                  setSize(null); setUrgency(null); setManualKm(5);
                  setAutoKm(null); setAutoMinutes(null); setUseAuto(true); setCheckError("");
                }
              }}
            >
              <MessageCircle size={18} />
              שלח הזמנה לוואטסאפ
            </a>
          );
        })()}


      </div>
    </div>
  );
}
