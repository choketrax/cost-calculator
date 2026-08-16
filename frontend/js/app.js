// AI Cost Auditor - Frontend Logic

const API_BASE = "https://ai-cost-auditorv2.dl-56e.workers.dev/api/v1";
let apiKey = localStorage.getItem("ai_cost_auditor_api_key") || "";

// DOM Elements
const settingsModal = document.getElementById("settings-modal");
const apiKeyInput = document.getElementById("api-key-input");
const saveSettingsBtn = document.getElementById("save-settings-btn");
const openSettingsBtn = document.getElementById("open-settings-btn");
const connectionDot = document.querySelector(".status-indicator .dot");
const connectionText = document.querySelector(".status-indicator .status-text");

// Upload Modal
const uploadModal = document.getElementById("upload-modal");
const btnNewAudit = document.getElementById("btn-new-audit");
const closeUploadBtn = document.getElementById("close-upload-btn");
const uploadForm = document.getElementById("upload-form");
const uploadStatus = document.getElementById("upload-status");

// Simulation Form
const simForm = document.getElementById("simulation-form");
const simAuditSelect = document.getElementById("sim-audit-id");
const simStatus = document.getElementById("sim-status");
const simBody = document.getElementById("simulations-body");

let currentAuditId = null;

// Navigation
const navItems = document.querySelectorAll('.nav-menu .nav-item');
const viewSections = document.querySelectorAll('.view-section');
const viewTitle = document.getElementById('current-view-title');

// Formatters
const formatCurrency = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
const formatNumber = (val) => new Intl.NumberFormat('en-US').format(val);

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  if (!apiKey) {
    settingsModal.classList.remove("hidden");
  } else {
    apiKeyInput.value = apiKey;
    checkConnection();
  }

  // Event Listeners
  saveSettingsBtn.addEventListener("click", () => {
    apiKey = apiKeyInput.value.trim();
    localStorage.setItem("ai_cost_auditor_api_key", apiKey);
    settingsModal.classList.add("hidden");
    checkConnection();
  });

  openSettingsBtn.addEventListener("click", () => {
    apiKeyInput.value = apiKey;
    settingsModal.classList.remove("hidden");
  });
  
  if (btnNewAudit) {
    btnNewAudit.addEventListener("click", () => {
      uploadModal.classList.remove("hidden");
      uploadStatus.textContent = "";
      uploadForm.reset();
    });
  }
  
  if (closeUploadBtn) {
    closeUploadBtn.addEventListener("click", () => {
      uploadModal.classList.add("hidden");
    });
  }
  
  const btnBackToAudits = document.getElementById("btn-back-to-audits");
  if (btnBackToAudits) {
    btnBackToAudits.addEventListener("click", () => {
      // Find the Audits nav item and switch to it
      const auditsNavItem = document.querySelector('.nav-item[data-view="audits"]');
      if (auditsNavItem) switchView("audits", auditsNavItem);
    });
  }
  
  if (uploadForm) {
    uploadForm.addEventListener("submit", handleUploadSubmit);
  }
  
  const btnDeleteAudit = document.getElementById("btn-delete-audit");
  if (btnDeleteAudit) {
    btnDeleteAudit.addEventListener("click", async () => {
      if (!currentAuditId) return;
      if (!confirm("Are you sure you want to completely delete this audit and all of its records?")) return;
      
      const prevText = btnDeleteAudit.textContent;
      btnDeleteAudit.textContent = "Deleting...";
      btnDeleteAudit.disabled = true;
      try {
        await apiFetch(`/audits/${currentAuditId}`, { method: "DELETE" });
        alert("Audit deleted successfully.");
        // Go back to audits view
        const auditsNavItem = document.querySelector('.nav-item[data-view="audits"]');
        if (auditsNavItem) switchView("audits", auditsNavItem);
      } catch (err) {
        console.error("Failed to delete", err);
        alert(`Failed to delete: ${err.message}`);
      } finally {
        btnDeleteAudit.textContent = prevText;
        btnDeleteAudit.disabled = false;
      }
    });
  }

  if (simForm) {
    simForm.addEventListener("submit", handleSimulationSubmit);
  }

  navItems.forEach(item => {
    item.addEventListener("click", (e) => {
      const viewId = e.currentTarget.getAttribute("data-view");
      switchView(viewId, e.currentTarget);
    });
  });
});

// Navigation Logic
function switchView(viewId, activeNavItem) {
  navItems.forEach(item => item.classList.remove("active"));
  activeNavItem.classList.add("active");
  
  viewSections.forEach(section => section.classList.remove("active", "hidden"));
  viewSections.forEach(section => {
    if (section.id === `view-${viewId}`) {
      section.classList.add("active");
    } else {
      section.classList.add("hidden");
    }
  });

  viewTitle.textContent = activeNavItem.textContent.trim();

  // Load data based on view
  if (viewId === "dashboard") loadDashboard();
  if (viewId === "audits") loadAudits();
  if (viewId === "pricing") loadPricing();
  if (viewId === "simulations") loadSimulationsSetup();
}

// Delete Audit from anywhere
async function deleteAudit(auditId) {
  if (!confirm("Are you sure you want to completely delete this audit?")) return;
  try {
    await apiFetch(`/audits/${auditId}`, { method: "DELETE" });
    alert("Audit deleted successfully.");
    loadDashboard();
    loadAudits();
    // If currently viewing this audit, go back
    if (currentAuditId === auditId) {
      const auditsNavItem = document.querySelector('.nav-item[data-view="audits"]');
      if (auditsNavItem) switchView("audits", auditsNavItem);
    }
  } catch (err) {
    console.error("Failed to delete", err);
    alert(`Failed to delete: ${err.message}`);
  }
}

// API Fetch Wrapper
async function apiFetch(endpoint, options = {}) {
  const headers = { ...options.headers };
  headers["X-API-Key"] = apiKey;
  
  if (!options.body || typeof options.body === "string") {
    headers["Content-Type"] = "application/json";
  }
  
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, { ...options, headers });
    if (res.status === 401) throw new Error("Unauthorized: Invalid API Key");
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`API Error ${res.status}: ${txt}`);
    }
    return await res.json();
  } catch (err) {
    console.error(`Fetch error on ${endpoint}:`, err);
    throw err;
  }
}

// Connection Check
async function checkConnection() {
  connectionDot.className = "dot";
  connectionText.textContent = "Connecting...";
  
  try {
    const data = await apiFetch("/health");
    if (data.status === "ok") {
      connectionDot.classList.add("connected");
      connectionText.textContent = "Connected";
      loadDashboard();
    }
  } catch (err) {
    connectionDot.classList.add("disconnected");
    connectionText.textContent = "Disconnected";
    if (err.message.includes("Unauthorized")) {
      settingsModal.classList.remove("hidden");
    }
  }
}

// Load Dashboard
async function loadDashboard() {
  try {
    const data = await apiFetch("/audits?limit=5");
    
    const tbody = document.getElementById("recent-audits-body");
    tbody.innerHTML = "";
    
    let totalCost = 0;
    let totalRequests = 0;

    if (data.data && data.data.length > 0) {
      data.data.forEach(audit => {
        totalCost += parseFloat(audit.baseline_monthly_cost || 0);
        totalRequests += parseInt(audit.total_records || 0);
        
        const tr = document.createElement("tr");
        tr.style.cursor = "pointer";
        tr.onclick = () => openAuditDetails(audit.audit_id);
        tr.innerHTML = `
          <td>${audit.audit_id.substring(0, 8)}...</td>
          <td>${audit.application || '-'}</td>
          <td>${audit.workload || '-'}</td>
          <td>${formatNumber(audit.total_records || 0)}</td>
          <td>${formatCurrency(audit.baseline_monthly_cost || 0)}</td>
          <td><button class="btn danger btn-sm" onclick="event.stopPropagation(); deleteAudit('${audit.audit_id}')" style="background-color: var(--danger); color: white; padding: 4px 8px; border: none; border-radius: 4px;">Delete</button></td>
        `;
        tbody.appendChild(tr);
      });
    } else {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">No audits found.</td></tr>';
    }

    document.getElementById("dash-total-cost").textContent = formatCurrency(totalCost);
    document.getElementById("dash-total-requests").textContent = formatNumber(totalRequests);
    
  } catch (err) {
    console.error("Dashboard error", err);
  }
}

// Load Pricing
async function loadPricing() {
  try {
    const data = await apiFetch("/pricing");
    const tbody = document.getElementById("pricing-body");
    tbody.innerHTML = "";

    if (data.data && data.data.length > 0) {
      data.data.forEach(entry => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><span class="badge ${entry.provider}">${entry.provider}</span></td>
          <td><strong>${entry.model}</strong></td>
          <td>$${parseFloat(entry.input_token_price).toFixed(2)}</td>
          <td>$${parseFloat(entry.output_token_price).toFixed(2)}</td>
          <td>$${parseFloat(entry.cached_input_price).toFixed(2)}</td>
          <td>${entry.source}</td>
        `;
        tbody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error("Pricing error", err);
  }
}

// Load Audits
async function loadAudits() {
  try {
    const data = await apiFetch("/audits?limit=50");
    const tbody = document.getElementById("all-audits-body");
    tbody.innerHTML = "";

    if (data.data && data.data.length > 0) {
      data.data.forEach(audit => {
        const tr = document.createElement("tr");
        tr.style.cursor = "pointer";
        tr.onclick = () => openAuditDetails(audit.audit_id);
        tr.innerHTML = `
          <td>${audit.audit_id}</td>
          <td>${audit.application || '-'}</td>
          <td>${audit.workload || '-'}</td>
          <td>${formatNumber(audit.total_records || 0)}</td>
          <td>${formatCurrency(audit.baseline_monthly_cost || 0)}</td>
          <td><button class="btn danger btn-sm" onclick="event.stopPropagation(); deleteAudit('${audit.audit_id}')" style="background-color: var(--danger); color: white; padding: 4px 8px; border: none; border-radius: 4px;">Delete</button></td>
        `;
        tbody.appendChild(tr);
      });
    } else {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">No audits found.</td></tr>';
    }
  } catch (err) {
    console.error("Audits error", err);
  }
}

// Open Audit Details
function openAuditDetails(auditId) {
  currentAuditId = auditId;
  // Deselect nav items
  navItems.forEach(item => item.classList.remove("active"));
  
  viewSections.forEach(section => {
    section.classList.remove("active");
    section.classList.add("hidden");
  });
  const detailsView = document.getElementById("view-audit-details");
  detailsView.classList.remove("hidden");
  detailsView.classList.add("active");
  
  viewTitle.textContent = "Audit Details";
  
  loadAuditDetails(auditId);
}

async function loadAuditDetails(auditId) {
  try {
    document.getElementById("detail-audit-id").textContent = auditId.substring(0, 8) + "...";
    document.getElementById("detail-total-cost").textContent = "Loading...";
    document.getElementById("detail-provider-body").innerHTML = '<tr><td colspan="2">Loading...</td></tr>';
    document.getElementById("detail-model-body").innerHTML = '<tr><td colspan="2">Loading...</td></tr>';

    const data = await apiFetch(`/audits/${auditId}/costs`);
    const costs = data.data;

    document.getElementById("detail-total-cost").textContent = formatCurrency(costs.total_cost || 0);
    document.getElementById("detail-total-requests").textContent = formatNumber(costs.total_requests || 0);
    document.getElementById("detail-input-tokens").textContent = formatNumber(costs.total_input_tokens || 0);
    document.getElementById("detail-output-tokens").textContent = formatNumber(costs.total_output_tokens || 0);

    const renderTable = (dict, tbodyId) => {
      const tbody = document.getElementById(tbodyId);
      tbody.innerHTML = "";
      if (!dict || Object.keys(dict).length === 0) {
        tbody.innerHTML = '<tr><td colspan="2">No data</td></tr>';
        return;
      }
      for (const [key, val] of Object.entries(dict)) {
        tbody.innerHTML += `<tr><td>${key}</td><td>${formatCurrency(val)}</td></tr>`;
      }
    };

    renderTable(costs.cost_by_provider, "detail-provider-body");
    renderTable(costs.cost_by_model, "detail-model-body");

  } catch (err) {
    console.error("Failed to load audit details", err);
    document.getElementById("detail-total-cost").textContent = "Error";
  }
}

// Handle Upload Submit
async function handleUploadSubmit(e) {
  e.preventDefault();
  
  const customer = document.getElementById("upload-customer").value;
  const app = document.getElementById("upload-app").value;
  const workload = document.getElementById("upload-workload").value;
  const fileInput = document.getElementById("upload-file");
  const file = fileInput.files[0];
  
  if (!file) return;

  try {
    uploadStatus.textContent = "Step 1/3: Creating audit container...";
    uploadStatus.style.color = "var(--text-primary)";
    
    const today = new Date().toISOString().split('T')[0];
    const auditRes = await apiFetch("/audits", {
      method: "POST",
      body: JSON.stringify({ 
        customer_name: customer, 
        notes: "Uploaded via UI",
        period_start: "2024-01-01",
        period_end: today
      })
    });
    const auditId = auditRes.data.audit_id;

    uploadStatus.textContent = "Step 2/3: Uploading file...";
    const formData = new FormData();
    formData.append("file", file);
    formData.append("application", app);
    formData.append("workload", workload);

    const uploadHeaders = { "X-API-Key": apiKey };
    const uploadReq = await fetch(`${API_BASE}/audits/${auditId}/upload`, {
      method: "POST",
      headers: uploadHeaders,
      body: formData
    });
    
    if (!uploadReq.ok) throw new Error(await uploadReq.text());
    const uploadRes = await uploadReq.json();
    const fileKey = uploadRes.data.file_key;

    uploadStatus.textContent = "Step 3/3: Ingesting records & calculating costs...";
    await apiFetch(`/audits/${auditId}/ingest`, {
      method: "POST",
      body: JSON.stringify({
        file_key: fileKey,
        application: app,
        workload: workload
      })
    });

    uploadStatus.style.color = "var(--success)";
    uploadStatus.textContent = "Success! Audit created and data ingested.";
    
    // Refresh Data
    setTimeout(() => {
      uploadModal.classList.add("hidden");
      openAuditDetails(auditId);
    }, 1500);

  } catch (err) {
    console.error("Upload process failed", err);
    uploadStatus.style.color = "var(--danger)";
    uploadStatus.textContent = `Error: ${err.message}`;
  }
}

// Setup Simulations
async function loadSimulationsSetup() {
  try {
    const data = await apiFetch("/audits?limit=50");
    simAuditSelect.innerHTML = '<option value="">Select an audit...</option>';
    
    if (data.data && data.data.length > 0) {
      data.data.forEach(audit => {
        const opt = document.createElement("option");
        opt.value = audit.audit_id;
        opt.textContent = `${audit.audit_id.substring(0,8)} - ${audit.application} (${formatCurrency(audit.baseline_monthly_cost || 0)})`;
        simAuditSelect.appendChild(opt);
      });
    }
  } catch (err) {
    console.error("Simulation setup error", err);
  }
}

// Handle Simulation Submit
async function handleSimulationSubmit(e) {
  e.preventDefault();
  
  const auditId = simAuditSelect.value;
  const savingsTarget = parseFloat(document.getElementById("sim-savings-target").value);
  const iterations = parseInt(document.getElementById("sim-iterations").value);
  
  if (!auditId) return;

  try {
    simStatus.textContent = "Running Monte Carlo Engine... this may take a moment.";
    simStatus.style.color = "var(--text-primary)";
    
    const requestBody = {
      n_iterations: iterations,
      savings_target: savingsTarget,
      seed: 42,
      distribution_specs: [
        { variable_name: "input_tokens", distribution: "uniform", params: { low: 0.8, high: 1.2 } },
        { variable_name: "output_tokens", distribution: "uniform", params: { low: 0.9, high: 1.1 } }
      ]
    };

    const res = await apiFetch(`/audits/${auditId}/simulate`, {
      method: "POST",
      body: JSON.stringify(requestBody)
    });

    simStatus.style.color = "var(--success)";
    simStatus.textContent = `Simulation complete! Manifest ID: ${res.data.manifest.simulation_id}`;

    // Add to table
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${res.data.manifest.simulation_id.substring(0,8)}...</td>
      <td>${auditId.substring(0,8)}...</td>
      <td>Default Scen</td>
      <td><span style="color:var(--success)">Success</span></td>
      <td>${formatCurrency(res.data.baseline_stats.p50)}</td>
      <td>${formatCurrency(res.data.optimized_stats.p50)}</td>
      <td style="color:var(--success)">${formatCurrency(res.data.monthly_savings_stats.p50)}</td>
    `;
    
    // Clear "No simulations run yet" if it exists
    if (simBody.innerHTML.includes("No simulations")) {
      simBody.innerHTML = "";
    }
    
    simBody.prepend(tr);

  } catch (err) {
    console.error("Simulation process failed", err);
    simStatus.style.color = "var(--danger)";
    simStatus.textContent = `Error: ${err.message}`;
  }
}
