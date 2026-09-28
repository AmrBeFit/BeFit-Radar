import React, { useState, useRef, useEffect } from 'react';

// Multi-select dropdown used by the report filters.
//  - `selected` is a list of values; an EMPTY list means "no filter" (show everything)
//  - options: [{ value, label, hint? }]
export default function MultiSelectFilter({ options, selected, onChange, allLabel, noun }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef(null);

  // close when clicking/tapping outside or pressing Escape
  useEffect(() => {
    if (!open) return;
    const onOutside = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('touchstart', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('touchstart', onOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const shown = options.filter(o => o.label.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (value) => {
    onChange(selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value]);
  };

  const summary = selected.length === 0
    ? allLabel
    : selected.length === 1
      ? (options.find(o => o.value === selected[0])?.label || selected[0])
      : `${selected.length} ${noun} selected`;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full p-2 bg-white text-slate-900 border border-slate-200 rounded-xl text-xs font-medium flex items-center justify-between gap-2 text-left cursor-pointer"
      >
        <span className="truncate">{summary}</span>
        <span className="text-slate-400 text-[10px] shrink-0">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div
          className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg p-2 space-y-2"
          style={{ zIndex: 40, minWidth: 220 }}
        >
          {options.length > 6 && (
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search ${noun}...`}
              className="w-full p-2 bg-slate-50 border border-slate-200 rounded-lg text-xs"
            />
          )}

          <div className="flex items-center justify-between text-[11px] font-bold px-1">
            <button type="button" onClick={() => onChange(options.map(o => o.value))} className="text-indigo-600 hover:underline cursor-pointer">
              Select all
            </button>
            <button type="button" onClick={() => onChange([])} className="text-slate-500 hover:underline cursor-pointer">
              Clear (show all)
            </button>
          </div>

          <div className="overflow-y-auto space-y-0.5" style={{ maxHeight: 240 }}>
            {shown.length === 0 && (
              <p className="text-[11px] text-slate-400 italic px-2 py-1">No matches</p>
            )}
            {shown.map(o => (
              <label key={o.value} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50 cursor-pointer text-xs">
                <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
                <span className="font-semibold text-slate-800 truncate">{o.label}</span>
                {o.hint && <span className="ml-auto text-[10px] text-slate-400 shrink-0">{o.hint}</span>}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
