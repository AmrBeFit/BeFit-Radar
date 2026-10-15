/* =====================================================================
   Payslip layout (shared by the HR Report and by "My payslip").
   buildPayslipsHtml(items) returns a complete HTML page, one payslip per page; printPayslips() prints it through a hidden frame
   (no pop-up window needed, so the browser's pop-up blocker never gets in the way). The employee can "Save as PDF" from the print dialog.
   `items` = [{ slip, period, month }] where slip is one row of the payroll result (HR) or the frozen copy released to the employee.
   ===================================================================== */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP`;

const lineRows = (rows) => rows.map(([label, value, strong]) => `<tr${strong ? ' class="strong"' : ''}><td>${esc(label)}</td><td class="num">${value}</td></tr>`).join('');

export function payslipBodyHtml({ slip, period, month }) {
  const earnings = [['Basic salary', money(slip.base)]];
  (slip.allowances || []).forEach((a) => earnings.push([a.name, money(a.amount)]));
  if (slip.bonus > 0) earnings.push([`Bonus${slip.bonusNote ? ` - ${slip.bonusNote}` : ''}`, money(slip.bonus)]);
  earnings.push(['Total earnings', money(slip.gross), true]);

  const ded = [];
  const attLines = (slip.days || []).filter((d) => d.deduction > 0);
  attLines.forEach((d) => ded.push([`${d.date} - ${d.status}${d.branch ? ` (${d.branch})` : ''}`, `- ${money(d.deduction)}`]));
  if (slip.capped) ded.push(['Attendance deductions limited to the monthly cap', `+ ${money(slip.attendanceDeduction - slip.attendanceDeductionApplied)}`]);
  (slip.manualDeductions || []).forEach((m) => ded.push([`${m.date} - ${m.category}: ${m.reason}`, `- ${money(m.amount)}`]));
  if (slip.otherDeduction > 0) ded.push([`Other deduction${slip.otherNote ? ` - ${slip.otherNote}` : ''}`, `- ${money(slip.otherDeduction)}`]);
  if (slip.insurance > 0) ded.push(['Insurance', `- ${money(slip.insurance)}`]);
  if (slip.tax > 0) ded.push(['Tax', `- ${money(slip.tax)}`]);
  if (ded.length === 0) ded.push(['No deductions', money(0)]);
  ded.push(['Total deductions', `- ${money(slip.totalDeductions)}`, true]);

  const b = slip.bank || {};
  const bankLine = b.accountMasked
    ? `${esc(b.bankName)} ${b.accountHolder ? '· ' + esc(b.accountHolder) : ''} · Account ${esc(b.accountMasked)}`
    : `${esc(b.bankName)} ${b.accountHolder ? '· ' + esc(b.accountHolder) : ''} · Account ${esc(b.accountNumber || '-')}${b.iban ? ' · IBAN ' + esc(b.iban) : ''}`;

  const stats = `Planned shifts: ${slip.planned} · On time: ${slip.onTime} · Late: ${slip.lateCount} (${slip.lateMinutes} min) · Left early: ${slip.leftEarlyCount} · Absent: ${slip.absentCount} · Approved leave days: ${slip.leaveDays}`;

  return `<section class="slip">
    <div class="head"><div><div class="brand">BeFit Eye</div><div class="muted">PAYSLIP</div></div>
      <div class="right"><div class="big">${esc(month)}</div><div class="muted">${esc(period.start)} → ${esc(period.end)}</div></div></div>
    <div class="who"><div><b>${esc(slip.username)}</b> <span class="muted">· ${esc(slip.role)}</span></div><div class="muted">${esc((slip.branches || []).join(', '))}</div></div>
    <div class="cols">
      <table><thead><tr><th colspan="2">Earnings</th></tr></thead><tbody>${lineRows(earnings)}</tbody></table>
      <table><thead><tr><th colspan="2">Deductions</th></tr></thead><tbody>${lineRows(ded)}</tbody></table>
    </div>
    <div class="net"><span>NET PAY</span><span>${money(slip.net)}</span></div>
    <div class="muted small">${esc(stats)}</div>
    <div class="muted small">Payment to: ${bankLine}</div>
  </section>`;
}

export function buildPayslipsHtml(items) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Payslips</title><style>
    *{box-sizing:border-box} body{font-family:Segoe UI,Arial,sans-serif;color:#0f172a;margin:0;padding:16px;background:#f1f5f9}
    .slip{background:#fff;border:1px solid #cbd5e1;border-radius:12px;padding:22px;margin:0 auto 16px;max-width:820px;page-break-after:always}
    .slip:last-child{page-break-after:auto}
    .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #ef3f28;padding-bottom:10px;margin-bottom:12px}
    .brand{font-size:22px;font-weight:900;color:#ef3f28}.big{font-size:20px;font-weight:800}.right{text-align:right}
    .who{display:flex;justify-content:space-between;margin-bottom:12px;font-size:14px}
    .muted{color:#64748b;font-size:12px}.small{margin-top:6px}
    .cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    table{width:100%;border-collapse:collapse;font-size:12px;align-self:start}
    th{background:#f1f5f9;text-align:left;padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
    td{padding:5px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}td.num{text-align:right;white-space:nowrap}
    tr.strong td{font-weight:800;border-top:2px solid #94a3b8}
    .net{display:flex;justify-content:space-between;align-items:center;background:#0f172a;color:#fff;border-radius:10px;padding:12px 16px;margin:14px 0 8px;font-size:18px;font-weight:900}
    @media print{body{background:#fff;padding:0}.slip{border:0;border-radius:0;margin:0;max-width:none}}
    @media (max-width:640px){.cols{grid-template-columns:1fr}}
  </style></head><body>${items.map(payslipBodyHtml).join('')}</body></html>`;
}

export function printPayslips(items) {
  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(iframe);
  const doc = iframe.contentWindow.document;
  doc.open(); doc.write(buildPayslipsHtml(items)); doc.close();
  setTimeout(() => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    setTimeout(() => document.body.removeChild(iframe), 2000);
  }, 300);
}
