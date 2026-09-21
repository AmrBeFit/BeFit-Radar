import React, { useState, useEffect, useMemo } from 'react';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';

// قائمة الفروع المتاحة في النظام
const DEFAULT_BRANCHES = ['Main Branch', 'Downtown Branch', 'VIP Branch'];

// بيانات مبدئية أولية فقط
const INITIAL_TRANSACTIONS = [
  {
    id: 'tx-101',
    branch: 'Main Branch',
    type: 'SUPPLIER',
    smallCount: 100,
    largeCount: 100,
    smallLost: 0,
    largeLost: 0,
    smallDamaged: 0,
    largeDamaged: 0,
    notes: 'Initial Batch from Supplier',
    addedBy: 'Admin',
    createdAt: '2026-09-15T10:30:00.000Z'
  },
  {
    id: 'tx-102',
    branch: 'Main Branch',
    type: 'LAUNDRY',
    smallCount: 50,
    largeCount: 75,
    smallLost: 10,
    largeLost: 5,
    smallDamaged: 40,
    largeDamaged: 20,
    notes: 'Weekly Laundry Pickup',
    addedBy: 'Facility Manager',
    createdAt: '2026-09-18T14:15:00.000Z'
  }
];

export default function TowelManagement({ currentUser, branchesList = DEFAULT_BRANCHES }) {
  const allowedRoles = [
    'ADMIN',
    'BRANCH MANAGER',
    'FACILITY MANAGER',
    'FACILITY MEMBER',
    'USER'
  ];

  const userRole = currentUser?.role?.toUpperCase() || '';
  const currentUsername = currentUser?.username || currentUser?.name || 'Unknown User';
  const hasAccess = allowedRoles.includes(userRole);
  const isAdmin = userRole === 'ADMIN';

  // 1. استرجاع أو تهيئة سجل المعاملات الدائم
  const [transactions, setTransactions] = useState(() => {
    const saved = localStorage.getItem('towel_transactions_v2');
    return saved ? JSON.parse(saved) : INITIAL_TRANSACTIONS;
  });

  const [activeTab, setActiveTab] = useState('report');
  const [editingTx, setEditingTx] = useState(null);

  // الفلاتر
  const [selectedBranchFilter, setSelectedBranchFilter] = useState('All');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // النماذج
  const [supplierForm, setSupplierForm] = useState({
    branch: branchesList[0] || 'Main Branch',
    small: '',
    large: '',
    supplierName: ''
  });

  const [laundryForm, setLaundryForm] = useState({
    branch: branchesList[0] || 'Main Branch',
    smallReceived: '',
    largeReceived: '',
    smallLost: '',
    largeLost: '',
    smallDamaged: '',
    largeDamaged: '',
    notes: ''
  });

  // حفظ المعاملات في LocalStorage فور كل تعديل أو حذف
  useEffect(() => {
    localStorage.setItem('towel_transactions_v2', JSON.stringify(transactions));
  }, [transactions]);

  if (!hasAccess) {
    return (
      <div className="p-8 text-center text-red-600 font-bold bg-red-50 rounded-2xl border border-red-200 max-w-2xl mx-auto my-10">
        Access Denied. You do not have permission to view the Towel Management System.
      </div>
    );
  }

  const formatDate = (isoString) => {
    if (!isoString) return 'N/A';
    const d = new Date(isoString);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  };

  // 2. فلترة المعاملات بناءً على الفرع والمدى الزمني المحدد
  const filteredTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      // فلتر الفرع
      if (selectedBranchFilter !== 'All' && tx.branch !== selectedBranchFilter) {
        return false;
      }
      // فلتر التاريخ
      const txTime = new Date(tx.createdAt).getTime();
      if (startDate) {
        const start = new Date(startDate).setHours(0, 0, 0, 0);
        if (txTime < start) return false;
      }
      if (endDate) {
        const end = new Date(endDate).setHours(23, 59, 59, 999);
        if (txTime > end) return false;
      }
      return true;
    });
  }, [transactions, selectedBranchFilter, startDate, endDate]);

  // 3. 🚨 الحساب الديناميكي اللحظي التلقائي للمخزون المتاح والإحصائيات
  const calculatedMetrics = useMemo(() => {
    // يحسب بناءً على قائمة المعاملات المفلترة لضمان التحديث عند الحذف أو التغيير
    return filteredTransactions.reduce(
      (acc, tx) => {
        if (tx.type === 'SUPPLIER') {
          acc.suppliedSmall += Number(tx.smallCount) || 0;
          acc.suppliedLarge += Number(tx.largeCount) || 0;
        } else if (tx.type === 'LAUNDRY') {
          acc.sentToLaundrySmall += Number(tx.smallCount) || 0;
          acc.sentToLaundryLarge += Number(tx.largeCount) || 0;
          acc.lostSmall += Number(tx.smallLost) || 0;
          acc.lostLarge += Number(tx.largeLost) || 0;
          acc.damagedSmall += Number(tx.smallDamaged) || 0;
          acc.damagedLarge += Number(tx.largeDamaged) || 0;
        }
        return acc;
      },
      {
        suppliedSmall: 0,
        suppliedLarge: 0,
        sentToLaundrySmall: 0,
        sentToLaundryLarge: 0,
        lostSmall: 0,
        lostLarge: 0,
        damagedSmall: 0,
        damagedLarge: 0
      }
    );
  }, [filteredTransactions]);

  // حساب المتبقي الحقيقي المتاح في الفرع
  const availableStock = {
    small: Math.max(0, calculatedMetrics.suppliedSmall - (calculatedMetrics.lostSmall + calculatedMetrics.damagedSmall)),
    large: Math.max(0, calculatedMetrics.suppliedLarge - (calculatedMetrics.lostLarge + calculatedMetrics.damagedLarge))
  };

  // تسجيل شحنة مورد جديدة
  const handleSupplierSubmit = (e) => {
    e.preventDefault();
    const addedSmall = Number(supplierForm.small) || 0;
    const addedLarge = Number(supplierForm.large) || 0;

    const newTx = {
      id: `tx-${Date.now()}`,
      branch: supplierForm.branch,
      type: 'SUPPLIER',
      smallCount: addedSmall,
      largeCount: addedLarge,
      smallLost: 0,
      largeLost: 0,
      smallDamaged: 0,
      largeDamaged: 0,
      notes: supplierForm.supplierName ? `Supplier: ${supplierForm.supplierName}` : 'New Supplier Shipment',
      addedBy: currentUsername,
      createdAt: new Date().toISOString()
    };

    setTransactions([newTx, ...transactions]);
    alert(`Successfully registered shipment for branch (${supplierForm.branch})! Added: ${addedSmall} Small & ${addedLarge} Large towels.`);
    setSupplierForm({ branch: branchesList[0] || 'Main Branch', small: '', large: '', supplierName: '' });
  };

  // تسجيل عملية مغسلة
  const handleLaundrySubmit = (e) => {
    e.preventDefault();
    const smallRec = Number(laundryForm.smallReceived) || 0;
    const smallLost = Number(laundryForm.smallLost) || 0;
    const smallDam = Number(laundryForm.smallDamaged) || 0;

    const largeRec = Number(laundryForm.largeReceived) || 0;
    const largeLost = Number(laundryForm.largeLost) || 0;
    const largeDam = Number(laundryForm.largeDamaged) || 0;

    const newTx = {
      id: `tx-${Date.now()}`,
      branch: laundryForm.branch,
      type: 'LAUNDRY',
      smallCount: smallRec,
      largeCount: largeRec,
      smallLost,
      largeLost,
      smallDamaged: smallDam,
      largeDamaged: largeDam,
      notes: laundryForm.notes || 'Laundry Dispatch',
      addedBy: currentUsername,
      createdAt: new Date().toISOString()
    };

    setTransactions([newTx, ...transactions]);
    alert(`Laundry operation logged successfully for branch (${laundryForm.branch})!`);
    setLaundryForm({
      branch: branchesList[0] || 'Main Branch',
      smallReceived: '', largeReceived: '',
      smallLost: '', largeLost: '',
      smallDamaged: '', largeDamaged: '',
      notes: ''
    });
  };

  // 🗑️ الحذف الفوري وتحديث الأرقام تلقائياً (Admin Only)
  const handleDeleteTransaction = (txId) => {
    if (!isAdmin) return alert('Action restricted to Admin only.');
    if (window.confirm('Are you sure you want to delete this log entry? Current stock will automatically adjust.')) {
      setTransactions((prev) => prev.filter((t) => t.id !== txId));
      alert('Entry deleted and inventory stock recalculated successfully!');
    }
  };

  // التعديل وتحديث الأرقام فوراً (Admin Only)
  const handleUpdateTransaction = (e) => {
    e.preventDefault();
    if (!isAdmin) return alert('Action restricted to Admin only.');

    setTransactions((prev) => prev.map((t) => (t.id === editingTx.id ? editingTx : t)));
    setEditingTx(null);
    alert('Entry updated and report metrics recalculated successfully!');
  };

  // تصدير التقرير إلى Excel حسب الفلاتر والفرع
  const exportToExcel = async () => {
    const workbook = new ExcelJS.Workbook();

    // الشيت الأول: ملخص التقرير
    const summarySheet = workbook.addWorksheet('Towel Audit Summary');
    summarySheet.columns = [
      { header: 'Branch Filter', key: 'branch', width: 20 },
      { header: 'Metric Status', key: 'metric', width: 30 },
      { header: 'Small Towels', key: 'small', width: 18 },
      { header: 'Large Towels', key: 'large', width: 18 },
      { header: 'Total Count', key: 'total', width: 18 }
    ];
    summarySheet.getRow(1).font = { bold: true };

    summarySheet.addRow({ branch: selectedBranchFilter, metric: 'Available Stock (In Branch)', small: availableStock.small, large: availableStock.large, total: availableStock.small + availableStock.large });
    summarySheet.addRow({ branch: selectedBranchFilter, metric: 'Sent to Laundry (In Process)', small: calculatedMetrics.sentToLaundrySmall, large: calculatedMetrics.sentToLaundryLarge, total: calculatedMetrics.sentToLaundrySmall + calculatedMetrics.sentToLaundryLarge });
    summarySheet.addRow({ branch: selectedBranchFilter, metric: 'Lost Items (Mffqood)', small: calculatedMetrics.lostSmall, large: calculatedMetrics.lostLarge, total: calculatedMetrics.lostSmall + calculatedMetrics.lostLarge });
    summarySheet.addRow({ branch: selectedBranchFilter, metric: 'Damaged / Wasted (Halik)', small: calculatedMetrics.damagedSmall, large: calculatedMetrics.damagedLarge, total: calculatedMetrics.damagedSmall + calculatedMetrics.damagedLarge });

    // الشيت الثاني: السجلات المفصلة
    const logsSheet = workbook.addWorksheet('Detailed Operations Log');
    logsSheet.columns = [
      { header: 'ID', key: 'id', width: 12 },
      { header: 'Branch', key: 'branch', width: 18 },
      { header: 'Type', key: 'type', width: 15 },
      { header: 'Small Qty', key: 'smallCount', width: 12 },
      { header: 'Large Qty', key: 'largeCount', width: 12 },
      { header: 'Small Lost', key: 'smallLost', width: 12 },
      { header: 'Large Lost', key: 'largeLost', width: 12 },
      { header: 'Small Damaged', key: 'smallDamaged', width: 15 },
      { header: 'Large Damaged', key: 'largeDamaged', width: 15 },
      { header: 'Added By', key: 'addedBy', width: 20 },
      { header: 'Date & Time', key: 'createdAt', width: 25 },
      { header: 'Notes', key: 'notes', width: 30 }
    ];
    logsSheet.getRow(1).font = { bold: true };

    filteredTransactions.forEach((tx) => {
      logsSheet.addRow({ ...tx, createdAt: formatDate(tx.createdAt) });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveAs(blob, `Towel_Audit_${selectedBranchFilter}_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6 text-left dir-ltr">
      
      {/* الهيدر العلوي وعرض المخزون المتاح الديناميكي */}
      <div style={{ backgroundColor: '#0f172a', color: '#ffffff' }} className="p-6 rounded-3xl shadow-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border border-slate-800">
        <div>
          <h1 className="text-2xl font-black text-white flex items-center gap-2">
            <span>🧺</span> Towel Management System
          </h1>
          <p className="text-slate-300 text-xs font-semibold mt-1">
            BeFit Radar &bull; Multi-Branch &amp; Dynamic Live Audit
          </p>
        </div>
        
        <div className="flex gap-4 w-full md:w-auto">
          <div style={{ backgroundColor: '#1e293b', borderColor: '#334155' }} className="p-3.5 rounded-2xl border text-center min-w-[130px] flex-1 md:flex-none">
            <span className="block text-[11px] text-slate-300 font-extrabold uppercase tracking-wider">Small Towels</span>
            <span className="text-2xl font-black text-amber-400 mt-0.5 block">{availableStock.small}</span>
          </div>
          <div style={{ backgroundColor: '#1e293b', borderColor: '#334155' }} className="p-3.5 rounded-2xl border text-center min-w-[130px] flex-1 md:flex-none">
            <span className="block text-[11px] text-slate-300 font-extrabold uppercase tracking-wider">Large Towels</span>
            <span className="text-2xl font-black text-indigo-400 mt-0.5 block">{availableStock.large}</span>
          </div>
        </div>
      </div>

      {/* التبويبات */}
      <div className="flex border-b border-slate-200 gap-6 pt-2">
        <button type="button" onClick={() => setActiveTab('report')} className={`pb-3 font-bold text-xs transition-all cursor-pointer ${activeTab === 'report' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-500 hover:text-slate-800'}`}>
          📊 Multi-Branch Audit Report
        </button>
        <button type="button" onClick={() => setActiveTab('supplier')} className={`pb-3 font-bold text-xs transition-all cursor-pointer ${activeTab === 'supplier' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-500 hover:text-slate-800'}`}>
          📦 Supplier Intake (New Stock)
        </button>
        <button type="button" onClick={() => setActiveTab('laundry')} className={`pb-3 font-bold text-xs transition-all cursor-pointer ${activeTab === 'laundry' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-500 hover:text-slate-800'}`}>
          🧼 Laundry Dispatch (Log Operations)
        </button>
      </div>

      {/* التبويب الأول: التقرير المفصل مع تصفية الفروع والمدى الزمني */}
      {activeTab === 'report' && (
        <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 space-y-6">
          
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b pb-4">
            <div>
              <h3 className="text-base font-bold text-slate-900">Towel Inventory &amp; Loss Audit Report</h3>
              <p className="text-xs text-slate-500">Accessible by Admins &amp; Facility Managers.</p>
            </div>

            {/* أدوات الفلترة والطباعة */}
            <div className="flex flex-wrap items-center gap-3">
              {/* فلتر اختيار الفرع */}
              <div className="flex items-center gap-2 bg-slate-50 border p-1.5 rounded-xl text-xs font-bold text-slate-700">
                <span>Branch:</span>
                <select
                  value={selectedBranchFilter}
                  onChange={(e) => setSelectedBranchFilter(e.target.value)}
                  className="bg-transparent font-bold outline-none cursor-pointer"
                >
                  <option value="All">All Branches</option>
                  {branchesList.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>

              {/* فلتر التاريخ */}
              <div className="flex items-center gap-2 bg-slate-50 border p-1.5 rounded-xl text-xs">
                <span className="font-bold text-slate-600">From:</span>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="bg-transparent font-semibold outline-none" />
                <span className="font-bold text-slate-600 ml-1">To:</span>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="bg-transparent font-semibold outline-none" />
              </div>

              <button onClick={exportToExcel} style={{ backgroundColor: '#059669', color: '#ffffff' }} className="px-4 py-2 rounded-xl text-xs font-bold shadow-md hover:opacity-90 border-0 cursor-pointer">
                Export Excel 📊
              </button>

              <button onClick={() => window.print()} style={{ backgroundColor: '#4f46e5', color: '#ffffff' }} className="px-4 py-2 rounded-xl text-xs font-bold shadow-md hover:opacity-90 border-0 cursor-pointer">
                Print PDF 🖨️
              </button>
            </div>
          </div>

          {/* جدول الإحصائيات الديناميكي */}
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-100 border-b border-slate-300 text-slate-800 text-xs font-black uppercase tracking-wider">
                  <th className="p-3">Metric / Status</th>
                  <th className="p-3 text-amber-700">Small Towels</th>
                  <th className="p-3 text-indigo-700">Large Towels</th>
                  <th className="p-3 text-slate-900">Total Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs font-semibold text-slate-800">
                <tr className="bg-emerald-50/50">
                  <td className="p-3 font-bold text-emerald-900">🟢 Available Stock (In Branch)</td>
                  <td className="p-3 font-black text-amber-600 text-sm">{availableStock.small}</td>
                  <td className="p-3 font-black text-indigo-600 text-sm">{availableStock.large}</td>
                  <td className="p-3 font-black text-emerald-900 text-sm">{availableStock.small + availableStock.large}</td>
                </tr>
                <tr>
                  <td className="p-3 font-bold text-slate-700">🧼 Sent to Laundry (In Process)</td>
                  <td className="p-3 font-bold text-slate-800">{calculatedMetrics.sentToLaundrySmall}</td>
                  <td className="p-3 font-bold text-slate-800">{calculatedMetrics.sentToLaundryLarge}</td>
                  <td className="p-3 font-bold text-slate-900">{calculatedMetrics.sentToLaundrySmall + calculatedMetrics.sentToLaundryLarge}</td>
                </tr>
                <tr className="bg-rose-50/40">
                  <td className="p-3 font-bold text-rose-700">❌ Lost Items (Mffqood)</td>
                  <td className="p-3 font-bold text-rose-600">{calculatedMetrics.lostSmall}</td>
                  <td className="p-3 font-bold text-rose-600">{calculatedMetrics.lostLarge}</td>
                  <td className="p-3 font-bold text-rose-800">{calculatedMetrics.lostSmall + calculatedMetrics.lostLarge}</td>
                </tr>
                <tr className="bg-slate-50">
                  <td className="p-3 font-bold text-slate-700">⚠️ Damaged / Wasted (Halik)</td>
                  <td className="p-3 font-bold text-slate-800">{calculatedMetrics.damagedSmall}</td>
                  <td className="p-3 font-bold text-slate-800">{calculatedMetrics.damagedLarge}</td>
                  <td className="p-3 font-bold text-slate-900">{calculatedMetrics.damagedSmall + calculatedMetrics.damagedLarge}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* جدول سجل السجلات المفصلة */}
          <div className="space-y-3 pt-4">
            <h4 className="font-bold text-slate-900 text-sm">Detailed Operation Logs ({filteredTransactions.length})</h4>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b text-slate-600 text-[11px] font-bold uppercase">
                    <th className="p-2.5">Date &amp; Time</th>
                    <th className="p-2.5">Branch</th>
                    <th className="p-2.5">Added By</th>
                    <th className="p-2.5">Type</th>
                    <th className="p-2.5">Small Qty</th>
                    <th className="p-2.5">Large Qty</th>
                    <th className="p-2.5">Lost (S / L)</th>
                    <th className="p-2.5">Damaged (S / L)</th>
                    <th className="p-2.5">Notes</th>
                    {isAdmin && <th className="p-2.5 text-right">Admin Actions</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {filteredTransactions.map((tx) => (
                    <tr key={tx.id} className="hover:bg-slate-50">
                      <td className="p-2.5 font-bold text-slate-700">{formatDate(tx.createdAt)}</td>
                      <td className="p-2.5 font-extrabold text-slate-900">{tx.branch}</td>
                      <td className="p-2.5 font-bold text-indigo-600">{tx.addedBy}</td>
                      <td className="p-2.5">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${tx.type === 'SUPPLIER' ? 'bg-indigo-100 text-indigo-800' : 'bg-amber-100 text-amber-800'}`}>
                          {tx.type}
                        </span>
                      </td>
                      <td className="p-2.5 font-semibold text-slate-800">{tx.smallCount}</td>
                      <td className="p-2.5 font-semibold text-slate-800">{tx.largeCount}</td>
                      <td className="p-2.5 font-semibold text-rose-600">{tx.smallLost} / {tx.largeLost}</td>
                      <td className="p-2.5 font-semibold text-slate-600">{tx.smallDamaged} / {tx.largeDamaged}</td>
                      <td className="p-2.5 text-slate-500 font-medium">{tx.notes}</td>
                      {isAdmin && (
                        <td className="p-2.5 text-right space-x-2">
                          <button onClick={() => setEditingTx(tx)} className="bg-indigo-50 text-indigo-600 hover:bg-indigo-600 hover:text-white px-2 py-1 rounded text-[10px] font-bold">Edit</button>
                          <button onClick={() => handleDeleteTransaction(tx.id)} className="bg-rose-50 text-rose-600 hover:bg-rose-600 hover:text-white px-2 py-1 rounded text-[10px] font-bold">Delete</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}

      {/* التبويب الثاني: إضافة توريد من المورد */}
      {activeTab === 'supplier' && (
        <form onSubmit={handleSupplierSubmit} className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 space-y-4">
          <h3 className="text-base font-bold text-slate-900">Register New Inventory Shipment from External Supplier</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Target Branch</label>
              <select
                value={supplierForm.branch}
                onChange={(e) => setSupplierForm({ ...supplierForm, branch: e.target.value })}
                className="w-full border border-slate-300 rounded-xl p-3 text-xs font-bold text-slate-900 bg-slate-50"
              >
                {branchesList.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Small Towels Quantity</label>
              <input type="number" min="0" value={supplierForm.small} onChange={(e) => setSupplierForm({ ...supplierForm, small: e.target.value })} className="w-full border border-slate-300 rounded-xl p-3 text-sm font-semibold text-slate-900 bg-slate-50" placeholder="e.g. 100" required />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Large Towels Quantity</label>
              <input type="number" min="0" value={supplierForm.large} onChange={(e) => setSupplierForm({ ...supplierForm, large: e.target.value })} className="w-full border border-slate-300 rounded-xl p-3 text-sm font-semibold text-slate-900 bg-slate-50" placeholder="e.g. 100" required />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">External Supplier Name</label>
              <input type="text" value={supplierForm.supplierName} onChange={(e) => setSupplierForm({ ...supplierForm, supplierName: e.target.value })} className="w-full border border-slate-300 rounded-xl p-3 text-sm font-semibold text-slate-900 bg-slate-50" placeholder="Vendor Name" />
            </div>
          </div>
          <button type="submit" style={{ backgroundColor: '#4f46e5', color: '#ffffff' }} className="w-full md:w-auto font-bold px-6 py-3 rounded-xl text-xs shadow-md border-0 cursor-pointer">Confirm &amp; Add Stock</button>
        </form>
      )}

      {/* التبويب الثالث: تسليمات المغسلة والهالك/المفقود */}
      {activeTab === 'laundry' && (
        <form onSubmit={handleLaundrySubmit} className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 space-y-6">
          <div className="flex justify-between items-center">
            <h3 className="text-base font-bold text-slate-900">Log Laundry Pickup &amp; Waste Records</h3>
            <div className="w-64">
              <label className="block text-xs font-bold text-slate-700 mb-1">Target Branch</label>
              <select
                value={laundryForm.branch}
                onChange={(e) => setLaundryForm({ ...laundryForm, branch: e.target.value })}
                className="w-full border border-slate-300 rounded-xl p-2.5 text-xs font-bold text-slate-900 bg-slate-50"
              >
                {branchesList.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="bg-amber-50/60 p-4 rounded-2xl border border-amber-200 space-y-3">
            <h4 className="font-bold text-amber-900 text-xs uppercase tracking-wider">1. Small Towels</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Received by Laundry</label>
                <input type="number" min="0" value={laundryForm.smallReceived} onChange={(e) => setLaundryForm({ ...laundryForm, smallReceived: e.target.value })} className="w-full border border-slate-300 rounded-xl p-2.5 text-sm font-semibold text-slate-900" placeholder="e.g. 50" />
              </div>
              <div>
                <label className="block text-xs font-bold text-rose-700 mb-1">Lost Quantity</label>
                <input type="number" min="0" value={laundryForm.smallLost} onChange={(e) => setLaundryForm({ ...laundryForm, smallLost: e.target.value })} className="w-full border border-rose-300 rounded-xl p-2.5 text-sm font-semibold text-slate-900 bg-rose-50/50" placeholder="e.g. 10" />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Damaged / Wasted</label>
                <input type="number" min="0" value={laundryForm.smallDamaged} onChange={(e) => setLaundryForm({ ...laundryForm, smallDamaged: e.target.value })} className="w-full border border-slate-300 rounded-xl p-2.5 text-sm font-semibold text-slate-900 bg-slate-100" placeholder="e.g. 40" />
              </div>
            </div>
          </div>

          <div className="bg-indigo-50/60 p-4 rounded-2xl border border-indigo-200 space-y-3">
            <h4 className="font-bold text-indigo-900 text-xs uppercase tracking-wider">2. Large Towels</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Received by Laundry</label>
                <input type="number" min="0" value={laundryForm.largeReceived} onChange={(e) => setLaundryForm({ ...laundryForm, largeReceived: e.target.value })} className="w-full border border-slate-300 rounded-xl p-2.5 text-sm font-semibold text-slate-900" placeholder="e.g. 75" />
              </div>
              <div>
                <label className="block text-xs font-bold text-rose-700 mb-1">Lost Quantity</label>
                <input type="number" min="0" value={laundryForm.largeLost} onChange={(e) => setLaundryForm({ ...laundryForm, largeLost: e.target.value })} className="w-full border border-rose-300 rounded-xl p-2.5 text-sm font-semibold text-slate-900 bg-rose-50/50" placeholder="e.g. 5" />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Damaged / Wasted</label>
                <input type="number" min="0" value={laundryForm.largeDamaged} onChange={(e) => setLaundryForm({ ...laundryForm, largeDamaged: e.target.value })} className="w-full border border-slate-300 rounded-xl p-2.5 text-sm font-semibold text-slate-900 bg-slate-100" placeholder="e.g. 20" />
              </div>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Additional Notes</label>
            <textarea value={laundryForm.notes} onChange={(e) => setLaundryForm({ ...laundryForm, notes: e.target.value })} rows="2" className="w-full border border-slate-300 rounded-xl p-3 text-sm font-semibold text-slate-900 bg-slate-50" placeholder="Add optional operational notes..." />
          </div>

          <button type="submit" style={{ backgroundColor: '#0f172a', color: '#ffffff' }} className="w-full font-bold py-3.5 rounded-xl text-xs shadow-md border-0 cursor-pointer">Save &amp; Confirm Laundry Transaction</button>
        </form>
      )}

      {/* نافذة التعديل للأدمن فقط */}
      {editingTx && isAdmin && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 max-w-md w-full shadow-2xl space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="font-bold text-slate-900 text-sm">Edit Entry Log (Admin Only)</h3>
              <button onClick={() => setEditingTx(null)} className="text-slate-400 font-bold">✕</button>
            </div>
            <form onSubmit={handleUpdateTransaction} className="space-y-3">
              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Branch</label>
                <select
                  value={editingTx.branch}
                  onChange={(e) => setEditingTx({ ...editingTx, branch: e.target.value })}
                  className="w-full p-2 border rounded-xl text-xs font-semibold"
                >
                  {branchesList.map((b) => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Small Count</label>
                  <input type="number" value={editingTx.smallCount} onChange={(e) => setEditingTx({ ...editingTx, smallCount: Number(e.target.value) })} className="w-full p-2 border rounded-xl text-xs font-semibold" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 mb-1">Large Count</label>
                  <input type="number" value={editingTx.largeCount} onChange={(e) => setEditingTx({ ...editingTx, largeCount: Number(e.target.value) })} className="w-full p-2 border rounded-xl text-xs font-semibold" />
                </div>
              </div>

              {editingTx.type === 'LAUNDRY' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold text-rose-600 mb-1">Small Lost</label>
                    <input type="number" value={editingTx.smallLost} onChange={(e) => setEditingTx({ ...editingTx, smallLost: Number(e.target.value) })} className="w-full p-2 border rounded-xl text-xs font-semibold" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-rose-600 mb-1">Large Lost</label>
                    <input type="number" value={editingTx.largeLost} onChange={(e) => setEditingTx({ ...editingTx, largeLost: Number(e.target.value) })} className="w-full p-2 border rounded-xl text-xs font-semibold" />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-bold text-slate-600 mb-1">Notes</label>
                <input type="text" value={editingTx.notes} onChange={(e) => setEditingTx({ ...editingTx, notes: e.target.value })} className="w-full p-2 border rounded-xl text-xs font-semibold" />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setEditingTx(null)} className="px-4 py-2 bg-slate-100 rounded-xl text-xs font-bold">Cancel</button>
                <button type="submit" className="px-4 py-2 bg-indigo-600 text-white rounded-xl text-xs font-bold">Save Changes</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}