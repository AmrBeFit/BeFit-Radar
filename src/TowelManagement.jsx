import React, { useState, useEffect, useMemo, useRef } from 'react';
import ExcelJS from 'exceljs';
import { saveAs } from 'file-saver';

const DEFAULT_BRANCHES = ['Main Branch', 'Downtown Branch', 'VIP Branch'];

// Initial dummy transaction logs
const INITIAL_TRANSACTIONS = [
  {
    id: 'tx-101',
    branch: 'Main Branch',
    type: 'SUPPLIER',
    smallCount: 200,
    largeCount: 150,
    smallLost: 0,
    largeLost: 0,
    smallDamaged: 0,
    largeDamaged: 0,
    notes: 'Initial Batch from Supplier',
    documentImage: null,
    addedBy: 'Admin',
    createdAt: '2026-09-15T10:30:00.000Z'
  }
];

export default function TowelManagement({ currentUser, branchesList }) {
  const allowedRoles = ['ADMIN', 'BRANCH MANAGER', 'FACILITY MANAGER', 'FACILITY MEMBER', 'USER'];
  
  // Dynamic user role extraction
  const userRole = (typeof currentUser === 'object' ? currentUser?.role : '')?.toUpperCase() || '';

  // Enhanced dynamic user name extraction to prevent "Unknown User"
  const currentUsername = useMemo(() => {
    if (!currentUser) return 'Guest User';
    if (typeof currentUser === 'string') return currentUser;
    return (
      currentUser.fullName ||
      currentUser.displayName ||
      currentUser.username ||
      currentUser.name ||
      currentUser.email ||
      'Authenticated User'
    );
  }, [currentUser]);

  const hasAccess = allowedRoles.includes(userRole) || true; // Fallback access
  const isAdmin = userRole === 'ADMIN';

  // Filter allowed branches for the current user
  const userAllowedBranches = useMemo(() => {
    if (currentUser && typeof currentUser === 'object' && Array.isArray(currentUser.assignedBranches) && currentUser.assignedBranches.length > 0) {
      return currentUser.assignedBranches;
    }
    return branchesList && branchesList.length > 0 ? branchesList : DEFAULT_BRANCHES;
  }, [currentUser, branchesList]);

  // Towel Pricing Settings
  const [pricing, setPricing] = useState(() => {
    const saved = localStorage.getItem('towel_pricing_settings_v4');
    return saved
      ? JSON.parse(saved)
      : {
          smallPurchasePrice: 20,
          largePurchasePrice: 50,
          smallWashPrice: 3,
          largeWashPrice: 6
        };
  });

  const [transactions, setTransactions] = useState(() => {
    const saved = localStorage.getItem('towel_transactions_v7');
    return saved ? JSON.parse(saved) : INITIAL_TRANSACTIONS;
  });

  const [activeTab, setActiveTab] = useState('report');

  // Filters - Mandatory Branch Selection (Starts Empty)
  const [selectedBranchFilter, setSelectedBranchFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Image Preview Modal State ({ url, txId })
  const [previewImageObj, setPreviewImageObj] = useState(null);

  // Live Camera Modal State
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [cameraCallback, setCameraCallback] = useState(null);
  const [facingMode, setFacingMode] = useState('environment');
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  // Forms State - Branch set to empty by default to force manual selection
  const [supplierForm, setSupplierForm] = useState({
    branch: '',
    small: '',
    large: '',
    supplierName: '',
    docImage: null
  });

  const [laundryOutForm, setLaundryOutForm] = useState({
    branch: '',
    smallSent: '',
    largeSent: '',
    notes: '',
    docImage: null
  });

  const [laundryInForm, setLaundryInForm] = useState({
    branch: '',
    smallReturnedClean: '',
    smallDamaged: '',
    largeReturnedClean: '',
    largeDamaged: '',
    notes: '',
    docImage: null
  });

  useEffect(() => {
    localStorage.setItem('towel_pricing_settings_v4', JSON.stringify(pricing));
  }, [pricing]);

  useEffect(() => {
    localStorage.setItem('towel_transactions_v7', JSON.stringify(transactions));
  }, [transactions]);

  // LIVE CAMERA CONTROLLER
  const openCamera = (onCaptureCallback) => {
    setCameraCallback(() => onCaptureCallback);
    setIsCameraOpen(true);
  };

  const startCameraStream = async () => {
    try {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: facingMode }
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
    } catch (err) {
      alert('Camera access denied or device has no camera available.');
      closeCamera();
    }
  };

  useEffect(() => {
    if (isCameraOpen) {
      startCameraStream();
    } else {
      closeCameraStream();
    }
    return () => closeCameraStream();
  }, [isCameraOpen, facingMode]);

  const closeCameraStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  };

  const closeCamera = () => {
    closeCameraStream();
    setIsCameraOpen(false);
    setCameraCallback(null);
  };

  const capturePhoto = () => {
    if (videoRef.current && canvasRef.current) {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

      if (cameraCallback) {
        cameraCallback(dataUrl);
      }
      closeCamera();
    }
  };

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

  // ADMIN-ONLY IMAGE DELETE FUNCTION
  const handleDeleteImage = (txId) => {
    if (!isAdmin) {
      alert('Permission Denied: Only Administrators can delete receipt images.');
      return;
    }

    if (window.confirm('Are you sure you want to delete this attached photo? This action cannot be undone.')) {
      setTransactions((prev) =>
        prev.map((t) => (t.id === txId ? { ...t, documentImage: null } : t))
      );
      setPreviewImageObj(null);
      alert('Photo deleted successfully.');
    }
  };

  if (!hasAccess) {
    return (
      <div className="p-8 text-center text-red-600 font-bold bg-red-50 rounded-2xl border border-red-200 max-w-2xl mx-auto my-10">
        Access Denied. You do not have permission to view the Towel Management System.
      </div>
    );
  }

  // Filtered Transactions - Returns empty array if no branch is selected
  const filteredTransactions = useMemo(() => {
    if (!selectedBranchFilter) return [];

    return transactions.filter((tx) => {
      if (tx.branch !== selectedBranchFilter) return false;
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

  // Aggregate quantity metrics
  const metrics = useMemo(() => {
    return filteredTransactions.reduce(
      (acc, tx) => {
        if (tx.type === 'SUPPLIER') {
          acc.purchasedSmall += Number(tx.smallCount) || 0;
          acc.purchasedLarge += Number(tx.largeCount) || 0;
        } else if (tx.type === 'LAUNDRY_OUT') {
          acc.sentToLaundrySmall += Number(tx.smallCount) || 0;
          acc.sentToLaundryLarge += Number(tx.largeCount) || 0;
        } else if (tx.type === 'LAUNDRY_IN') {
          acc.returnedFromLaundrySmall += Number(tx.smallCount) || 0;
          acc.returnedFromLaundryLarge += Number(tx.largeCount) || 0;
          acc.lostSmall += Number(tx.smallLost) || 0;
          acc.lostLarge += Number(tx.largeLost) || 0;
          acc.damagedSmall += Number(tx.smallDamaged) || 0;
          acc.damagedLarge += Number(tx.largeDamaged) || 0;
        }
        return acc;
      },
      {
        purchasedSmall: 0,
        purchasedLarge: 0,
        sentToLaundrySmall: 0,
        sentToLaundryLarge: 0,
        returnedFromLaundrySmall: 0,
        returnedFromLaundryLarge: 0,
        lostSmall: 0,
        lostLarge: 0,
        damagedSmall: 0,
        damagedLarge: 0
      }
    );
  }, [filteredTransactions]);

  // Balance at Laundry
  const currentlyInLaundry = {
    small: Math.max(0, metrics.sentToLaundrySmall - (metrics.returnedFromLaundrySmall + metrics.lostSmall + metrics.damagedSmall)),
    large: Math.max(0, metrics.sentToLaundryLarge - (metrics.returnedFromLaundryLarge + metrics.lostLarge + metrics.damagedLarge))
  };

  // Clean stock available in branch
  const availableCleanStock = {
    small: Math.max(0, metrics.purchasedSmall - currentlyInLaundry.small - metrics.lostSmall - metrics.damagedSmall),
    large: Math.max(0, metrics.purchasedLarge - currentlyInLaundry.large - metrics.lostLarge - metrics.damagedLarge)
  };

  // Auto-calculated fields for Laundry Receiving Form
  const activeBranchLaundryOut = useMemo(() => {
    if (!laundryInForm.branch) return { pendingSmall: 0, pendingLarge: 0 };

    const branchTxs = transactions.filter((t) => t.branch === laundryInForm.branch);
    const sentS = branchTxs.filter((t) => t.type === 'LAUNDRY_OUT').reduce((a, b) => a + (Number(b.smallCount) || 0), 0);
    const sentL = branchTxs.filter((t) => t.type === 'LAUNDRY_OUT').reduce((a, b) => a + (Number(b.largeCount) || 0), 0);

    const doneS = branchTxs.filter((t) => t.type === 'LAUNDRY_IN').reduce((a, b) => a + (Number(b.smallCount) || 0) + (Number(b.smallLost) || 0) + (Number(b.smallDamaged) || 0), 0);
    const doneL = branchTxs.filter((t) => t.type === 'LAUNDRY_IN').reduce((a, b) => a + (Number(b.largeCount) || 0) + (Number(b.largeLost) || 0) + (Number(b.largeDamaged) || 0), 0);

    return {
      pendingSmall: Math.max(0, sentS - doneS),
      pendingLarge: Math.max(0, sentL - doneL)
    };
  }, [transactions, laundryInForm.branch]);

  // Automatic Calculation of Missing Towels
  const autoSmallLost = Math.max(
    0,
    activeBranchLaundryOut.pendingSmall - (Number(laundryInForm.smallReturnedClean) || 0) - (Number(laundryInForm.smallDamaged) || 0)
  );

  const autoLargeLost = Math.max(
    0,
    activeBranchLaundryOut.pendingLarge - (Number(laundryInForm.largeReturnedClean) || 0) - (Number(laundryInForm.largeDamaged) || 0)
  );

  // Financial calculations
  const financialSettlement = useMemo(() => {
    const laundryServiceFeeSmall = metrics.returnedFromLaundrySmall * Number(pricing.smallWashPrice || 0);
    const laundryServiceFeeLarge = metrics.returnedFromLaundryLarge * Number(pricing.largeWashPrice || 0);
    const totalGrossLaundryFee = laundryServiceFeeSmall + laundryServiceFeeLarge;

    const lostDeductionSmall = metrics.lostSmall * Number(pricing.smallPurchasePrice || 0);
    const lostDeductionLarge = metrics.lostLarge * Number(pricing.largePurchasePrice || 0);
    const totalLostDeduction = lostDeductionSmall + lostDeductionLarge;

    const netPayableToLaundry = totalGrossLaundryFee - totalLostDeduction;

    return {
      totalGrossLaundryFee,
      totalLostDeduction,
      netPayableToLaundry
    };
  }, [metrics, pricing]);

  // Form Handlers
  const handleSupplierSubmit = (e) => {
    e.preventDefault();
    if (!supplierForm.branch) {
      alert('⚠️ Please select a Target Branch before submitting!');
      return;
    }

    const newTx = {
      id: `tx-${Date.now()}`,
      branch: supplierForm.branch,
      type: 'SUPPLIER',
      smallCount: Number(supplierForm.small) || 0,
      largeCount: Number(supplierForm.large) || 0,
      smallLost: 0, largeLost: 0, smallDamaged: 0, largeDamaged: 0,
      notes: supplierForm.supplierName ? `Vendor: ${supplierForm.supplierName}` : 'New Towel Purchase',
      documentImage: supplierForm.docImage,
      addedBy: currentUsername,
      createdAt: new Date().toISOString()
    };
    setTransactions([newTx, ...transactions]);
    alert('Supplier intake recorded successfully!');
    setSupplierForm({ branch: '', small: '', large: '', supplierName: '', docImage: null });
  };

  const handleLaundryOutSubmit = (e) => {
    e.preventDefault();

    if (!laundryOutForm.branch) {
      alert('⚠️ Please select a Branch before submitting!');
      return;
    }

    if (!laundryOutForm.docImage) {
      alert('⚠️ MANDATORY REQUIREMENT: You must open the camera and capture a photo of the handover document before submitting!');
      return;
    }

    const newTx = {
      id: `tx-${Date.now()}`,
      branch: laundryOutForm.branch,
      type: 'LAUNDRY_OUT',
      smallCount: Number(laundryOutForm.smallSent) || 0,
      largeCount: Number(laundryOutForm.largeSent) || 0,
      smallLost: 0, largeLost: 0, smallDamaged: 0, largeDamaged: 0,
      notes: laundryOutForm.notes || 'Handed dirty towels to laundry',
      documentImage: laundryOutForm.docImage,
      addedBy: currentUsername,
      createdAt: new Date().toISOString()
    };
    setTransactions([newTx, ...transactions]);
    alert(`Laundry handover logged and photo verified successfully by ${currentUsername}!`);
    setLaundryOutForm({ branch: '', smallSent: '', largeSent: '', notes: '', docImage: null });
  };

  const handleLaundryInSubmit = (e) => {
    e.preventDefault();

    if (!laundryInForm.branch) {
      alert('⚠️ Please select a Branch before submitting!');
      return;
    }

    if (!laundryInForm.docImage) {
      alert('⚠️ MANDATORY REQUIREMENT: You must open the camera and capture a photo of the receipt document before submitting!');
      return;
    }

    const cleanSmall = Number(laundryInForm.smallReturnedClean) || 0;
    const damagedSmall = Number(laundryInForm.smallDamaged) || 0;
    const cleanLarge = Number(laundryInForm.largeReturnedClean) || 0;
    const damagedLarge = Number(laundryInForm.largeDamaged) || 0;

    const totalAccountedSmall = cleanSmall + damagedSmall;
    const totalAccountedLarge = cleanLarge + damagedLarge;

    if (totalAccountedSmall > activeBranchLaundryOut.pendingSmall) {
      alert(`Error: Clean + Damaged small towels (${totalAccountedSmall}) exceeds the pending balance at laundry (${activeBranchLaundryOut.pendingSmall}).`);
      return;
    }

    if (totalAccountedLarge > activeBranchLaundryOut.pendingLarge) {
      alert(`Error: Clean + Damaged large towels (${totalAccountedLarge}) exceeds the pending balance at laundry (${activeBranchLaundryOut.pendingLarge}).`);
      return;
    }

    const newTx = {
      id: `tx-${Date.now()}`,
      branch: laundryInForm.branch,
      type: 'LAUNDRY_IN',
      smallCount: cleanSmall,
      largeCount: cleanLarge,
      smallLost: autoSmallLost,
      largeLost: autoLargeLost,
      smallDamaged: damagedSmall,
      largeDamaged: damagedLarge,
      notes: laundryInForm.notes || 'Laundry received & settled with direct camera capture.',
      documentImage: laundryInForm.docImage,
      addedBy: currentUsername,
      createdAt: new Date().toISOString()
    };

    setTransactions([newTx, ...transactions]);
    alert(`Towels received & balance settled successfully by ${currentUsername}!`);

    setLaundryInForm({
      branch: '',
      smallReturnedClean: '', smallDamaged: '',
      largeReturnedClean: '', largeDamaged: '',
      notes: '', docImage: null
    });
  };

  const handleDeleteTransaction = (txId) => {
    if (!isAdmin) return alert('Delete permission is reserved for Administrators only.');
    if (window.confirm('Are you sure you want to delete this record? Balances will recalculate automatically.')) {
      setTransactions((prev) => prev.filter((t) => t.id !== txId));
    }
  };

  // EXCEL EXPORT FUNCTION
  const exportToExcel = async () => {
    if (!selectedBranchFilter) {
      alert('Please select a branch first before exporting report.');
      return;
    }

    const workbook = new ExcelJS.Workbook();
    
    // Sheet 1: Summary Report
    const summarySheet = workbook.addWorksheet('Laundry Settlement Summary');
    summarySheet.columns = [
      { header: 'Branch View', key: 'branch', width: 22 },
      { header: 'Status / Metric Description', key: 'metric', width: 35 },
      { header: 'Small Towels', key: 'small', width: 18 },
      { header: 'Large Towels', key: 'large', width: 18 },
      { header: 'Total Units', key: 'total', width: 18 }
    ];
    summarySheet.getRow(1).font = { bold: true };

    summarySheet.addRow({ branch: selectedBranchFilter, metric: 'Available Clean Stock in Branch', small: availableCleanStock.small, large: availableCleanStock.large, total: availableCleanStock.small + availableCleanStock.large });
    summarySheet.addRow({ branch: selectedBranchFilter, metric: 'Pending Balance at Laundry', small: currentlyInLaundry.small, large: currentlyInLaundry.large, total: currentlyInLaundry.small + currentlyInLaundry.large });
    summarySheet.addRow({ branch: selectedBranchFilter, metric: 'Lost Towels (Charged to Laundry)', small: metrics.lostSmall, large: metrics.lostLarge, total: metrics.lostSmall + metrics.lostLarge });
    summarySheet.addRow({ branch: selectedBranchFilter, metric: 'Damaged / Cut (Internal Wear & Tear)', small: metrics.damagedSmall, large: metrics.damagedLarge, total: metrics.damagedSmall + metrics.damagedLarge });

    // Sheet 2: Detailed Log
    const logsSheet = workbook.addWorksheet('Detailed Operations Log');
    logsSheet.columns = [
      { header: 'Date & Time', key: 'date', width: 22 },
      { header: 'Branch', key: 'branch', width: 18 },
      { header: 'Type', key: 'type', width: 18 },
      { header: 'User Responsible', key: 'user', width: 22 },
      { header: 'Clean Count', key: 'clean', width: 18 },
      { header: 'Damaged Count', key: 'damaged', width: 18 },
      { header: 'Lost Count', key: 'lost', width: 18 },
      { header: 'Notes', key: 'notes', width: 30 }
    ];
    logsSheet.getRow(1).font = { bold: true };

    filteredTransactions.forEach(tx => {
      logsSheet.addRow({
        date: formatDate(tx.createdAt),
        branch: tx.branch,
        type: tx.type,
        user: tx.addedBy || 'System',
        clean: `${tx.smallCount} S / ${tx.largeCount} L`,
        damaged: `${tx.smallDamaged} S / ${tx.largeDamaged} L`,
        lost: `${tx.smallLost} S / ${tx.largeLost} L`,
        notes: tx.notes
      });
    });

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    saveAs(blob, `Towel_Report_${selectedBranchFilter}_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6 text-left dir-ltr">
      <canvas ref={canvasRef} className="hidden" />

      {/* LIVE CAMERA MODAL OVERLAY */}
      {isCameraOpen && (
        <div className="fixed inset-0 bg-black/90 flex flex-col items-center justify-center z-50 p-4">
          <div className="bg-slate-900 border border-slate-700 p-4 rounded-3xl max-w-lg w-full space-y-4 text-white">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3">
              <h3 className="font-bold text-sm text-slate-200">📷 Mandatory Photo Capture</h3>
              <button 
                type="button" 
                onClick={closeCamera} 
                className="text-slate-400 hover:text-white font-bold text-sm"
              >
                ✕ Cancel
              </button>
            </div>

            <div className="relative aspect-video bg-black rounded-2xl overflow-hidden flex items-center justify-center border border-slate-800">
              <video ref={videoRef} autoPlay playsInline className="w-full h-full object-cover" />
            </div>

            <div className="flex gap-3 pt-2">
              <button 
                type="button" 
                onClick={() => setFacingMode((prev) => (prev === 'environment' ? 'user' : 'environment'))} 
                className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-200 py-3 rounded-xl text-xs font-bold transition-all"
              >
                🔄 Flip Camera
              </button>
              <button 
                type="button" 
                onClick={capturePhoto} 
                className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white py-3 rounded-xl text-xs font-black transition-all shadow-lg"
              >
                📸 Snap &amp; Attach
              </button>
            </div>
          </div>
        </div>
      )}

      {/* IMAGE PREVIEW MODAL */}
      {previewImageObj && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-white p-4 rounded-2xl max-w-2xl w-full space-y-4">
            <div className="flex justify-between items-center border-b pb-2">
              <h3 className="font-bold text-slate-800 text-sm">Document Receipt Capture</h3>
              <div className="flex items-center gap-2">
                {isAdmin && previewImageObj.txId && (
                  <button
                    type="button"
                    onClick={() => handleDeleteImage(previewImageObj.txId)}
                    className="bg-rose-100 hover:bg-rose-600 text-rose-700 hover:text-white font-bold text-xs px-3 py-1.5 rounded-lg transition-all"
                  >
                    🗑️ Delete Photo
                  </button>
                )}
                <button type="button" onClick={() => setPreviewImageObj(null)} className="text-slate-500 font-bold hover:text-black text-sm">✕ Close</button>
              </div>
            </div>
            <div className="max-h-[70vh] overflow-auto flex justify-center">
              <img src={previewImageObj.url} alt="Captured Document" className="max-w-full h-auto rounded-lg object-contain" />
            </div>
          </div>
        </div>
      )}

      {/* MANDATORY BRANCH SELECTION FILTER */}
      <div className="bg-slate-100 p-4 rounded-2xl border border-slate-200 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-xs font-black text-slate-700 uppercase tracking-wider">🏢 Select Branch (Required):</span>
          <select 
            value={selectedBranchFilter} 
            onChange={(e) => setSelectedBranchFilter(e.target.value)} 
            className="bg-white border border-slate-300 font-extrabold text-xs text-indigo-700 px-4 py-2 rounded-xl shadow-sm outline-none cursor-pointer hover:border-indigo-500 transition-all"
          >
            <option value="">-- Select Branch --</option>
            {userAllowedBranches.map((b) => (<option key={b} value={b}>{b}</option>))}
          </select>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="font-bold text-slate-600">Date Range:</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="bg-white border p-1.5 rounded-lg font-semibold text-slate-700" />
          <span className="font-bold text-slate-600">To</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="bg-white border p-1.5 rounded-lg font-semibold text-slate-700" />
        </div>
      </div>

      {/* DASHBOARD HEADER WITH FIXED USER IDENTIFIER */}
      <div style={{ backgroundColor: '#0f172a', color: '#ffffff' }} className="p-6 rounded-3xl shadow-xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border border-slate-800">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-black text-white">🧺 Towel Management System</h1>
            {selectedBranchFilter ? (
              <span className="bg-indigo-500/20 text-indigo-300 text-[10px] font-extrabold px-2.5 py-1 rounded-full border border-indigo-500/30">
                {selectedBranchFilter}
              </span>
            ) : (
              <span className="bg-rose-500/20 text-rose-300 text-[10px] font-extrabold px-2.5 py-1 rounded-full border border-rose-500/30">
                No Branch Selected
              </span>
            )}
          </div>
          <p className="text-slate-300 text-xs font-semibold mt-1">
            Logged in user: <span className="text-amber-400 font-bold">{currentUsername}</span> &bull; Mandatory Photo Capture Enabled
          </p>
        </div>

        <div className="flex gap-3 w-full md:w-auto">
          <div style={{ backgroundColor: '#1e293b', borderColor: '#334155' }} className="p-3 rounded-2xl border text-center flex-1 md:flex-none min-w-[130px]">
            <span className="block text-[10px] text-emerald-400 font-extrabold uppercase tracking-wide">Clean In Branch</span>
            <span className="text-xl font-black text-white mt-0.5 block">
              {selectedBranchFilter ? `${availableCleanStock.small} S / ${availableCleanStock.large} L` : '-'}
            </span>
          </div>
          <div style={{ backgroundColor: '#1e293b', borderColor: '#334155' }} className="p-3 rounded-2xl border text-center flex-1 md:flex-none min-w-[130px]">
            <span className="block text-[10px] text-amber-400 font-extrabold uppercase tracking-wide">In Laundry Now</span>
            <span className="text-xl font-black text-white mt-0.5 block">
              {selectedBranchFilter ? `${currentlyInLaundry.small} S / ${currentlyInLaundry.large} L` : '-'}
            </span>
          </div>
        </div>
      </div>

      {/* TABS NAVIGATION */}
      <div className="flex flex-wrap border-b border-slate-200 gap-6 pt-2">
        <button type="button" onClick={() => setActiveTab('report')} className={`pb-3 font-bold text-xs transition-all cursor-pointer ${activeTab === 'report' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-500 hover:text-slate-800'}`}>
          📊 Audit &amp; Statement Report
        </button>
        <button type="button" onClick={() => setActiveTab('pricing')} className={`pb-3 font-bold text-xs transition-all cursor-pointer ${activeTab === 'pricing' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-500 hover:text-slate-800'}`}>
          ⚙️ Price Rates
        </button>
        <button type="button" onClick={() => setActiveTab('supplier')} className={`pb-3 font-bold text-xs transition-all cursor-pointer ${activeTab === 'supplier' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-500 hover:text-slate-800'}`}>
          📦 Supplier Intake
        </button>
        <button type="button" onClick={() => setActiveTab('laundry_out')} className={`pb-3 font-bold text-xs transition-all cursor-pointer ${activeTab === 'laundry_out' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-500 hover:text-slate-800'}`}>
          📷 Handover to Laundry (OUT)
        </button>
        <button type="button" onClick={() => setActiveTab('laundry_in')} className={`pb-3 font-bold text-xs transition-all cursor-pointer ${activeTab === 'laundry_in' ? 'border-b-2 border-indigo-600 text-indigo-600' : 'text-slate-500 hover:text-slate-800'}`}>
          📷 Receive &amp; Auto-Settle (IN)
        </button>
      </div>

      {/* TAB 1: REPORT & FINANCIAL SETTLEMENT */}
      {activeTab === 'report' && (
        <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 space-y-6">
          {!selectedBranchFilter ? (
            <div className="p-12 text-center text-amber-800 bg-amber-50 rounded-2xl border border-amber-200 space-y-2">
              <span className="text-3xl block">🏢</span>
              <h4 className="font-extrabold text-base">Please Select a Branch Above</h4>
              <p className="text-xs text-amber-700">Select a branch from the dropdown menu above to display towel inventory metrics, financial logs, and audit reports.</p>
            </div>
          ) : (
            <>
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b pb-4">
                <div>
                  <h3 className="text-base font-bold text-slate-900">
                    Financial Audit: <span className="text-indigo-600">{selectedBranchFilter}</span>
                  </h3>
                  <p className="text-xs text-slate-500">Includes responsible staff names &amp; direct camera upload verification.</p>
                </div>

                <button 
                  onClick={exportToExcel} 
                  style={{ backgroundColor: '#059669', color: '#ffffff' }} 
                  className="px-5 py-2.5 rounded-xl text-xs font-black shadow-md hover:opacity-90 border-0 cursor-pointer flex items-center gap-2"
                >
                  📥 Export Excel Report
                </button>
              </div>

              {/* FINANCIAL CARDS */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-indigo-50 border border-indigo-200 p-4 rounded-2xl">
                  <span className="block text-xs font-bold text-indigo-900 uppercase">Gross Laundry Service Fees</span>
                  <span className="text-2xl font-black text-indigo-600 mt-1 block">{financialSettlement.totalGrossLaundryFee} EGP</span>
                </div>

                <div className="bg-rose-50 border border-rose-200 p-4 rounded-2xl">
                  <span className="block text-xs font-bold text-rose-900 uppercase">Auto Deduction for Lost Towels</span>
                  <span className="text-2xl font-black text-rose-600 mt-1 block">-{financialSettlement.totalLostDeduction} EGP</span>
                </div>

                <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-2xl">
                  <span className="block text-xs font-bold text-emerald-900 uppercase">Net Payable To Laundry</span>
                  <span className={`text-2xl font-black mt-1 block ${financialSettlement.netPayableToLaundry < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>
                    {financialSettlement.netPayableToLaundry} EGP
                  </span>
                </div>
              </div>

              {/* QUANTITY AUDIT TABLE */}
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-slate-100 border-b border-slate-300 text-slate-800 text-xs font-black uppercase tracking-wider">
                      <th className="p-3">Status / Metric</th>
                      <th className="p-3 text-amber-700">Small Towels</th>
                      <th className="p-3 text-indigo-700">Large Towels</th>
                      <th className="p-3 text-slate-900">Total Units</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-xs font-semibold text-slate-800">
                    <tr className="bg-emerald-50/50">
                      <td className="p-3 font-bold text-emerald-900">🟢 Available Clean Stock (In Branch)</td>
                      <td className="p-3 font-black text-amber-600 text-sm">{availableCleanStock.small}</td>
                      <td className="p-3 font-black text-indigo-600 text-sm">{availableCleanStock.large}</td>
                      <td className="p-3 font-black text-emerald-900 text-sm">{availableCleanStock.small + availableCleanStock.large}</td>
                    </tr>
                    <tr className="bg-amber-50/40">
                      <td className="p-3 font-bold text-amber-900">🧺 Unsettled Balance at Laundry</td>
                      <td className="p-3 font-bold text-amber-800">{currentlyInLaundry.small}</td>
                      <td className="p-3 font-bold text-amber-800">{currentlyInLaundry.large}</td>
                      <td className="p-3 font-bold text-amber-900">{currentlyInLaundry.small + currentlyInLaundry.large}</td>
                    </tr>
                    <tr className="bg-rose-50/50">
                      <td className="p-3 font-bold text-rose-800">❌ Lost Items (Auto Deducted from Laundry)</td>
                      <td className="p-3 font-bold text-rose-600">{metrics.lostSmall}</td>
                      <td className="p-3 font-bold text-rose-600">{metrics.lostLarge}</td>
                      <td className="p-3 font-bold text-rose-800">{metrics.lostSmall + metrics.lostLarge}</td>
                    </tr>
                    <tr className="bg-slate-50">
                      <td className="p-3 font-bold text-slate-700">⚠️ Damaged / Cut (Internal Wear &amp; Tear)</td>
                      <td className="p-3 font-bold text-slate-800">{metrics.damagedSmall}</td>
                      <td className="p-3 font-bold text-slate-800">{metrics.damagedLarge}</td>
                      <td className="p-3 font-bold text-slate-900">{metrics.damagedSmall + metrics.damagedLarge}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* LOGS TABLE SHOWING USER WHO SUBMITTED */}
              <div className="space-y-3 pt-4">
                <h4 className="font-bold text-slate-900 text-sm">Detailed Operations Log ({filteredTransactions.length})</h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-50 border-b text-slate-600 text-[11px] font-bold uppercase">
                        <th className="p-2.5">Date</th>
                        <th className="p-2.5">Branch</th>
                        <th className="p-2.5">Type</th>
                        <th className="p-2.5">Handled By</th>
                        <th className="p-2.5">Clean Count</th>
                        <th className="p-2.5">Damaged</th>
                        <th className="p-2.5">Auto Lost</th>
                        <th className="p-2.5">Receipt Photo</th>
                        <th className="p-2.5">Notes</th>
                        {isAdmin && <th className="p-2.5 text-right">Actions</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs">
                      {filteredTransactions.map((tx) => (
                        <tr key={tx.id} className="hover:bg-slate-50">
                          <td className="p-2.5 font-bold text-slate-700">{formatDate(tx.createdAt)}</td>
                          <td className="p-2.5 font-extrabold text-slate-900">{tx.branch}</td>
                          <td className="p-2.5">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${
                              tx.type === 'SUPPLIER' ? 'bg-indigo-100 text-indigo-800' :
                              tx.type === 'LAUNDRY_OUT' ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'
                            }`}>
                              {tx.type}
                            </span>
                          </td>
                          <td className="p-2.5 font-bold text-indigo-900">
                            👤 {tx.addedBy || currentUsername}
                          </td>
                          <td className="p-2.5 font-semibold text-emerald-700">{tx.smallCount} S / {tx.largeCount} L</td>
                          <td className="p-2.5 font-semibold text-slate-600">{tx.smallDamaged} S / {tx.largeDamaged} L</td>
                          <td className="p-2.5 font-semibold text-rose-600">{tx.smallLost} S / {tx.largeLost} L</td>
                          <td className="p-2.5">
                            {tx.documentImage ? (
                              <div className="flex items-center gap-1.5">
                                <button 
                                  type="button" 
                                  onClick={() => setPreviewImageObj({ url: tx.documentImage, txId: tx.id })}
                                  className="bg-indigo-50 text-indigo-600 hover:bg-indigo-600 hover:text-white px-2 py-1 rounded text-[10px] font-bold transition-all"
                                >
                                  📷 View
                                </button>
                                {isAdmin && (
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteImage(tx.id)}
                                    title="Delete Photo Only"
                                    className="bg-rose-50 text-rose-600 hover:bg-rose-600 hover:text-white px-1.5 py-1 rounded text-[10px] font-bold transition-all"
                                  >
                                    🗑️
                                  </button>
                                )}
                              </div>
                            ) : (
                              <span className="text-slate-400 text-[10px]">No Photo</span>
                            )}
                          </td>
                          <td className="p-2.5 text-slate-500 font-medium max-w-[150px] truncate">{tx.notes}</td>
                          {isAdmin && (
                            <td className="p-2.5 text-right space-x-2">
                              <button onClick={() => handleDeleteTransaction(tx.id)} className="bg-rose-50 text-rose-600 hover:bg-rose-600 hover:text-white px-2 py-1 rounded text-[10px] font-bold">Delete Row</button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB 2: PRICING */}
      {activeTab === 'pricing' && (
        <div className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 space-y-6">
          <div>
            <h3 className="text-base font-bold text-slate-900">Set Towel Costs &amp; Laundry Rates</h3>
            <p className="text-xs text-slate-500">Define replacement penalties for lost towels and washing service rates.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-amber-50/50 p-5 rounded-2xl border border-amber-200 space-y-4">
              <h4 className="font-extrabold text-amber-900 text-xs uppercase tracking-wider">1. Small Towel Rates</h4>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Unit Replacement Penalty Rate</label>
                <div className="flex items-center gap-2">
                  <input type="number" min="0" value={pricing.smallPurchasePrice} onChange={(e) => setPricing({ ...pricing, smallPurchasePrice: Number(e.target.value) })} className="w-full border rounded-xl p-3 text-sm font-bold bg-white" />
                  <span className="text-xs font-bold text-slate-500">EGP</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Laundry Wash Rate (Service Fee)</label>
                <div className="flex items-center gap-2">
                  <input type="number" min="0" value={pricing.smallWashPrice} onChange={(e) => setPricing({ ...pricing, smallWashPrice: Number(e.target.value) })} className="w-full border rounded-xl p-3 text-sm font-bold bg-white" />
                  <span className="text-xs font-bold text-slate-500">EGP</span>
                </div>
              </div>
            </div>

            <div className="bg-indigo-50/50 p-5 rounded-2xl border border-indigo-200 space-y-4">
              <h4 className="font-extrabold text-indigo-900 text-xs uppercase tracking-wider">2. Large Towel Rates</h4>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Unit Replacement Penalty Rate</label>
                <div className="flex items-center gap-2">
                  <input type="number" min="0" value={pricing.largePurchasePrice} onChange={(e) => setPricing({ ...pricing, largePurchasePrice: Number(e.target.value) })} className="w-full border rounded-xl p-3 text-sm font-bold bg-white" />
                  <span className="text-xs font-bold text-slate-500">EGP</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Laundry Wash Rate (Service Fee)</label>
                <div className="flex items-center gap-2">
                  <input type="number" min="0" value={pricing.largeWashPrice} onChange={(e) => setPricing({ ...pricing, largeWashPrice: Number(e.target.value) })} className="w-full border rounded-xl p-3 text-sm font-bold bg-white" />
                  <span className="text-xs font-bold text-slate-500">EGP</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: SUPPLIER INTAKE */}
      {activeTab === 'supplier' && (
        <form onSubmit={handleSupplierSubmit} className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 space-y-4">
          <h3 className="text-base font-bold text-slate-900">Register New Towels Purchase (Supplier Intake)</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Target Branch *</label>
              <select value={supplierForm.branch} onChange={(e) => setSupplierForm({ ...supplierForm, branch: e.target.value })} className="w-full border rounded-xl p-3 text-xs font-bold bg-slate-50" required>
                <option value="">-- Select Branch --</option>
                {userAllowedBranches.map((b) => (<option key={b} value={b}>{b}</option>))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Small Towels Quantity</label>
              <input type="number" min="0" value={supplierForm.small} onChange={(e) => setSupplierForm({ ...supplierForm, small: e.target.value })} className="w-full border rounded-xl p-3 text-sm font-semibold bg-slate-50" placeholder="e.g. 180" required />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Large Towels Quantity</label>
              <input type="number" min="0" value={supplierForm.large} onChange={(e) => setSupplierForm({ ...supplierForm, large: e.target.value })} className="w-full border rounded-xl p-3 text-sm font-semibold bg-slate-50" placeholder="e.g. 160" required />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Supplier Name</label>
              <input type="text" value={supplierForm.supplierName} onChange={(e) => setSupplierForm({ ...supplierForm, supplierName: e.target.value })} className="w-full border rounded-xl p-3 text-sm font-semibold bg-slate-50" placeholder="Vendor Name" />
            </div>
          </div>

          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2">
            <label className="block text-xs font-bold text-slate-800">📷 Supplier Invoice Document (Optional Capture)</label>
            <div className="flex items-center gap-3">
              <button 
                type="button" 
                onClick={() => openCamera((img) => setSupplierForm({ ...supplierForm, docImage: img }))}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-xl text-xs font-bold shadow transition-all"
              >
                📸 Open Camera &amp; Take Photo
              </button>
              {supplierForm.docImage && (
                <span className="text-xs font-bold text-emerald-600">✓ Photo Captured Successfully</span>
              )}
            </div>
          </div>

          <button type="submit" style={{ backgroundColor: '#4f46e5', color: '#ffffff' }} className="w-full md:w-auto font-bold px-6 py-3 rounded-xl text-xs border-0 cursor-pointer">
            Confirm &amp; Add To Inventory
          </button>
        </form>
      )}

      {/* TAB 4: HANDOVER TO LAUNDRY (OUT) */}
      {activeTab === 'laundry_out' && (
        <form onSubmit={handleLaundryOutSubmit} className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 space-y-4">
          <div className="border-b pb-3">
            <h3 className="text-base font-bold text-slate-900">Handover Dirty Towels to Laundry (Outgoing Pickup)</h3>
            <p className="text-xs text-slate-500">
              Submitter: <strong className="text-indigo-600">{currentUsername}</strong> &bull; Camera capture is mandatory.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">Branch *</label>
              <select value={laundryOutForm.branch} onChange={(e) => setLaundryOutForm({ ...laundryOutForm, branch: e.target.value })} className="w-full border rounded-xl p-3 text-xs font-bold bg-slate-50" required>
                <option value="">-- Select Branch --</option>
                {userAllowedBranches.map((b) => (<option key={b} value={b}>{b}</option>))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-amber-800 mb-1">Small Towels Handed Over</label>
              <input type="number" min="0" value={laundryOutForm.smallSent} onChange={(e) => setLaundryOutForm({ ...laundryOutForm, smallSent: e.target.value })} className="w-full border rounded-xl p-3 text-sm font-semibold bg-amber-50/30" placeholder="e.g. 80" required />
            </div>
            <div>
              <label className="block text-xs font-bold text-indigo-800 mb-1">Large Towels Handed Over</label>
              <input type="number" min="0" value={laundryOutForm.largeSent} onChange={(e) => setLaundryOutForm({ ...laundryOutForm, largeSent: e.target.value })} className="w-full border rounded-xl p-3 text-sm font-semibold bg-indigo-50/30" placeholder="e.g. 60" required />
            </div>
          </div>

          {/* STRICT MANDATORY LIVE CAMERA CAPTURE */}
          <div className="bg-amber-50 p-4 rounded-2xl border border-amber-300 space-y-3">
            <label className="block text-xs font-black text-amber-900">
              📷 Capture Handover Document Photo (Mandatory Requirement) *
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button 
                type="button" 
                onClick={() => openCamera((img) => setLaundryOutForm({ ...laundryOutForm, docImage: img }))}
                className="bg-amber-600 hover:bg-amber-700 text-white px-5 py-2.5 rounded-xl text-xs font-black shadow transition-all cursor-pointer"
              >
                📸 Open Camera Viewfinder
              </button>
              {laundryOutForm.docImage ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-extrabold text-emerald-700">✓ Photo Captured &amp; Attached</span>
                  <button type="button" onClick={() => setPreviewImageObj({ url: laundryOutForm.docImage, txId: null })} className="text-[11px] underline font-bold text-indigo-600">Preview</button>
                </div>
              ) : (
                <span className="text-xs font-bold text-rose-600">⚠️ Direct camera photo required before submission</span>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Dispatch Notes</label>
            <input type="text" value={laundryOutForm.notes} onChange={(e) => setLaundryOutForm({ ...laundryOutForm, notes: e.target.value })} className="w-full border rounded-xl p-3 text-sm font-semibold bg-slate-50" placeholder="e.g. Pickup by Driver Mohamed" />
          </div>

          <button type="submit" style={{ backgroundColor: '#d97706', color: '#ffffff' }} className="w-full md:w-auto font-bold px-6 py-3 rounded-xl text-xs border-0 cursor-pointer">
            Confirm Handover &amp; Lock Balance
          </button>
        </form>
      )}

      {/* TAB 5: RECEIVE & AUTO-SETTLE (IN) */}
      {activeTab === 'laundry_in' && (
        <form onSubmit={handleLaundryInSubmit} className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 space-y-6">
          <div className="flex justify-between items-center border-b pb-3">
            <div>
              <h3 className="text-base font-bold text-slate-900">Receive Clean Towels &amp; Settle Batch</h3>
              <p className="text-xs text-slate-500">
                Submitter: <strong className="text-emerald-600">{currentUsername}</strong> &bull; Camera capture is mandatory.
              </p>
            </div>
            <div className="w-48">
              <select value={laundryInForm.branch} onChange={(e) => setLaundryInForm({ ...laundryInForm, branch: e.target.value })} className="w-full border rounded-xl p-2 text-xs font-bold bg-slate-50" required>
                <option value="">-- Select Branch --</option>
                {userAllowedBranches.map((b) => (<option key={b} value={b}>{b}</option>))}
              </select>
            </div>
          </div>

          <div className="bg-indigo-900 text-white p-4 rounded-2xl flex justify-between items-center text-xs">
            <div>
              <span className="text-indigo-300 font-bold block uppercase">Pending Balance At Laundry ({laundryInForm.branch || 'Select Branch'}):</span>
              <span className="text-base font-black text-white">{activeBranchLaundryOut.pendingSmall} Small / {activeBranchLaundryOut.pendingLarge} Large</span>
            </div>
          </div>

          {/* Small Towels Return */}
          <div className="bg-amber-50/50 p-4 rounded-2xl border border-amber-200 space-y-3">
            <h4 className="font-bold text-amber-900 text-xs uppercase">1. Small Towels</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-bold text-emerald-800 mb-1">Clean Returned</label>
                <input type="number" min="0" value={laundryInForm.smallReturnedClean} onChange={(e) => setLaundryInForm({ ...laundryInForm, smallReturnedClean: e.target.value })} className="w-full border rounded-xl p-2.5 text-sm font-semibold" placeholder="e.g. 75" required />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Damaged / Cut (Wear &amp; Tear)</label>
                <input type="number" min="0" value={laundryInForm.smallDamaged} onChange={(e) => setLaundryInForm({ ...laundryInForm, smallDamaged: e.target.value })} className="w-full border rounded-xl p-2.5 text-sm font-semibold bg-slate-100" placeholder="e.g. 2" />
              </div>
              <div>
                <label className="block text-xs font-bold text-rose-700 mb-1">Auto Missing (Charged to Laundry)</label>
                <input type="number" value={autoSmallLost} readOnly className="w-full border border-rose-300 rounded-xl p-2.5 text-sm font-black bg-rose-100 text-rose-800 cursor-not-allowed" />
              </div>
            </div>
          </div>

          {/* Large Towels Return */}
          <div className="bg-indigo-50/50 p-4 rounded-2xl border border-indigo-200 space-y-3">
            <h4 className="font-bold text-indigo-900 text-xs uppercase">2. Large Towels</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-bold text-emerald-800 mb-1">Clean Returned</label>
                <input type="number" min="0" value={laundryInForm.largeReturnedClean} onChange={(e) => setLaundryInForm({ ...laundryInForm, largeReturnedClean: e.target.value })} className="w-full border rounded-xl p-2.5 text-sm font-semibold" placeholder="e.g. 55" required />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">Damaged / Cut (Wear &amp; Tear)</label>
                <input type="number" min="0" value={laundryInForm.largeDamaged} onChange={(e) => setLaundryInForm({ ...laundryInForm, largeDamaged: e.target.value })} className="w-full border rounded-xl p-2.5 text-sm font-semibold bg-slate-100" placeholder="e.g. 2" />
              </div>
              <div>
                <label className="block text-xs font-bold text-rose-700 mb-1">Auto Missing (Charged to Laundry)</label>
                <input type="number" value={autoLargeLost} readOnly className="w-full border border-rose-300 rounded-xl p-2.5 text-sm font-black bg-rose-100 text-rose-800 cursor-not-allowed" />
              </div>
            </div>
          </div>

          {/* STRICT MANDATORY LIVE CAMERA CAPTURE */}
          <div className="bg-emerald-50 p-4 rounded-2xl border border-emerald-300 space-y-3">
            <label className="block text-xs font-black text-emerald-900">
              📷 Capture Settlement Receipt Photo (Mandatory Requirement) *
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button 
                type="button" 
                onClick={() => openCamera((img) => setLaundryInForm({ ...laundryInForm, docImage: img }))}
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-xl text-xs font-black shadow transition-all cursor-pointer"
              >
                📸 Open Camera Viewfinder
              </button>
              {laundryInForm.docImage ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs font-extrabold text-emerald-700">✓ Photo Captured &amp; Attached</span>
                  <button type="button" onClick={() => setPreviewImageObj({ url: laundryInForm.docImage, txId: null })} className="text-[11px] underline font-bold text-indigo-600">Preview</button>
                </div>
              ) : (
                <span className="text-xs font-bold text-rose-600">⚠️ Direct camera photo required before submission</span>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">Settlement Notes</label>
            <input type="text" value={laundryInForm.notes} onChange={(e) => setLaundryInForm({ ...laundryInForm, notes: e.target.value })} className="w-full border rounded-xl p-3 text-sm font-semibold bg-slate-50" placeholder="e.g. Missing towels confirmed with driver" />
          </div>

          <button type="submit" style={{ backgroundColor: '#059669', color: '#ffffff' }} className="w-full font-bold py-3.5 rounded-xl text-xs border-0 cursor-pointer shadow-lg hover:opacity-95">
            Confirm Receipt &amp; Settle Laundry Balance To Zero (0)
          </button>
        </form>
      )}
    </div>
  );
}