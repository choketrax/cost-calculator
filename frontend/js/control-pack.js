export const ControlPack = {
  apiBase: '',
  apiKey: '',

  init() {
    this.apiBase = localStorage.getItem('auditor_api_base') || 'https://ai-cost-auditorv2.dl-56e.workers.dev';
    this.apiKey = localStorage.getItem('auditor_api_key') || '';
    
    // Check if we have credentials
    if (!this.apiKey) {
      console.warn("Control Pack initialized without API key. Some features may not work.");
    }
  },

  async apiCall(endpoint, options = {}) {
    if (!this.apiBase) return null;
    const url = `${this.apiBase}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {})
    };
    
    try {
      const response = await fetch(url, { ...options, headers });
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      return await response.json();
    } catch (err) {
      console.error(`ControlPack API Error (${endpoint}):`, err);
      return null;
    }
  },

  // API calls
  async fetchSpendMetrics(auditId = 'all', periodStart = '', periodEnd = '') {
    // Mock data for UI demonstration purposes as the prompt implies we are building frontend UI structure
    return {
      totalAvoided: 12400,
      grossMargin: 45.2,
      marginTrend: 2.1,
      actionsPrevented: 1243,
      annualSavingsProj: 148800,
      trendData: [120, 150, 90, 200, 310, 180, 240]
    };
  },

  async fetchBudgets() {
    return [
      { id: 'pol-1', name: 'Customer Support Agent', spent: 780, budget: 1000, status: 'WARNING', circuitOpen: false },
      { id: 'pol-2', name: 'Code Review Bot', spent: 150, budget: 500, status: 'OK', circuitOpen: false },
      { id: 'pol-3', name: 'Data Extraction Pipeline', spent: 2100, budget: 2000, status: 'EXCEEDED', circuitOpen: true },
    ];
  },

  async fetchAlerts() {
    return {
      summary: { allow: 45000, alert: 120, route: 450, pause: 23 },
      totalValuePrevented: 3450,
      logs: [
        { id: 1, timestamp: '2026-09-10T14:22:00Z', scope: 'Data Pipeline', rule: 'Max Cost per Request', action: 'pause', avoided: 1.2 },
        { id: 2, timestamp: '2026-09-10T14:15:00Z', scope: 'Customer Support', rule: 'Fallback Routing', action: 'route', avoided: 0.4 },
        { id: 3, timestamp: '2026-09-10T13:45:00Z', scope: 'Code Review', rule: 'Budget > 90%', action: 'alert', avoided: 0 },
      ]
    };
  },
  
  async fetchPolicies() {
    return this.apiCall('/api/v1/policies');
  },

  async fetchSpendByEntity() {
    return {
      customers: [
        { name: 'Acme Corp', spend: 4500, totalPct: 45, margin: 32, trend: 'up' },
        { name: 'Globex', spend: 3200, totalPct: 32, margin: 48, trend: 'down' },
        { name: 'Initech', spend: 1800, totalPct: 18, margin: -5, trend: 'up' },
        { name: 'Soylent', spend: 500, totalPct: 5, margin: 60, trend: 'flat' }
      ],
      projects: [
        { name: 'Customer Portal', spend: 6000, totalPct: 60, margin: 40, trend: 'up' },
        { name: 'Internal Dashboard', spend: 4000, totalPct: 40, margin: 25, trend: 'flat' }
      ]
    };
  },

  async fetchCostPerOutcome() {
    return [
      { episodeType: 'Resolve Ticket', totalCost: 1250, successful: 1200, costPerSuccess: 1.04, costPerFailure: 0.15, quality: 4.8, trend: 'improving' },
      { episodeType: 'Extract Invoice', totalCost: 800, successful: 750, costPerSuccess: 1.06, costPerFailure: 0.08, quality: 4.5, trend: 'degrading' },
      { episodeType: 'Generate Report', totalCost: 450, successful: 400, costPerSuccess: 1.12, costPerFailure: 0.20, quality: 4.2, trend: 'improving' }
    ];
  },

  async fetchOptimizations() {
    return {
      pending: [
        { id: 'opt-1', beforeModel: 'gpt-4-turbo', afterModel: 'claude-3-haiku', qualityBefore: 4.6, qualityAfter: 4.5, costReduction: 85, annualSavings: 45000 }
      ],
      active: [
        { id: 'opt-2', beforeModel: 'gpt-4', afterModel: 'gpt-3.5-turbo', qualityBefore: 4.2, qualityAfter: 4.1, costReduction: 90, annualSavings: 120000 }
      ]
    };
  },

  // View 1: Executive savings summary
  async renderSavingsSummary() {
    const container = document.getElementById('scp-savings-content');
    container.innerHTML = `<div class="text-center mt-4">Loading savings data...</div>`;
    
    const data = await this.fetchSpendMetrics();
    
    const sparklineHtml = data.trendData.map(val => {
      const height = (val / Math.max(...data.trendData)) * 100;
      return `<div class="scp-spark-bar" style="height: ${height}%" title="$${val}"></div>`;
    }).join('');

    container.innerHTML = `
      <div class="card-header">
        <h3>Executive Savings Summary</h3>
      </div>
      <div class="stats-grid">
        <div class="stat-card glass-panel" style="border: 1px solid var(--success);">
          <h3>Total Avoided Spending</h3>
          <div class="stat-value" style="color: var(--success);">$${data.totalAvoided.toLocaleString()}</div>
          <div class="scp-sparkline">
            ${sparklineHtml}
          </div>
        </div>
        <div class="stat-card glass-panel">
          <h3>Gross Margin</h3>
          <div class="stat-value">${data.grossMargin}%</div>
          <div class="stat-change ${data.marginTrend > 0 ? 'positive' : 'negative'}">
            ${data.marginTrend > 0 ? '↑' : '↓'} ${Math.abs(data.marginTrend)}% vs last month
          </div>
        </div>
        <div class="stat-card glass-panel">
          <h3>Actions Prevented</h3>
          <div class="stat-value">${data.actionsPrevented.toLocaleString()}</div>
          <div class="stat-subtitle">Route + Pause decisions</div>
        </div>
        <div class="stat-card glass-panel highlight">
          <h3>Projected Annual Savings</h3>
          <div class="stat-value">$${data.annualSavingsProj.toLocaleString()}</div>
          <div class="stat-subtitle">Based on proof reports</div>
        </div>
      </div>
    `;
  },

  // View 2: Spend by customer/project
  async renderSpendByEntity() {
    const container = document.getElementById('scp-spend-content');
    container.innerHTML = `<div class="text-center mt-4">Loading spend data...</div>`;
    
    const data = await this.fetchSpendByEntity();
    
    let currentTab = 'customers';
    
    const renderContent = () => {
      const items = data[currentTab];
      
      // Calculate concentration
      const colors = ['#8b5cf6', '#ec4899', '#3b82f6', 'rgba(255,255,255,0.1)'];
      const top3 = items.slice(0, 3);
      const otherPct = 100 - top3.reduce((sum, item) => sum + item.totalPct, 0);
      
      let concHtml = top3.map((item, i) => `<div class="scp-conc-seg" style="width: ${item.totalPct}%; background: ${colors[i]}" title="${item.name}: ${item.totalPct}%"></div>`).join('');
      if (otherPct > 0) concHtml += `<div class="scp-conc-seg" style="width: ${otherPct}%; background: ${colors[3]}" title="Other: ${otherPct}%"></div>`;

      const rowsHtml = items.map(item => {
        const hasAlert = item.margin < 0;
        return `
          <tr>
            <td>
              ${item.name}
              ${hasAlert ? '<span class="scp-badge critical" style="margin-left:8px">Negative Margin</span>' : ''}
            </td>
            <td>$${item.spend.toLocaleString()}</td>
            <td>${item.totalPct}%</td>
            <td style="color: ${item.margin < 0 ? 'var(--danger)' : 'var(--success)'}">${item.margin}%</td>
            <td>${item.trend === 'up' ? '↗' : item.trend === 'down' ? '↘' : '→'}</td>
          </tr>
        `;
      }).join('');

      container.innerHTML = `
        <div class="card glass-panel">
          <div class="card-header">
            <h3>Spend by Entity</h3>
          </div>
          
          <div class="scp-tabs">
            <div class="scp-tab ${currentTab === 'customers' ? 'active' : ''}" data-tab="customers">Customers</div>
            <div class="scp-tab ${currentTab === 'projects' ? 'active' : ''}" data-tab="projects">Projects</div>
          </div>
          
          <div style="margin-bottom: 24px;">
            <h4 style="font-size: 0.85rem; color: var(--text-secondary); text-transform: uppercase; margin-bottom: 8px;">Spend Concentration</h4>
            <div class="scp-concentration-bar">
              ${concHtml}
            </div>
            <div style="display: flex; gap: 16px; margin-top: 8px; font-size: 0.8rem; color: var(--text-secondary);">
              ${top3.map((item, i) => `<div style="display: flex; align-items: center; gap: 4px;"><div style="width:10px;height:10px;background:${colors[i]};border-radius:2px;"></div> ${item.name} (${item.totalPct}%)</div>`).join('')}
            </div>
          </div>

          <div class="table-responsive">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Spend</th>
                  <th>% of Total</th>
                  <th>Margin</th>
                  <th>Trend</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml}
              </tbody>
            </table>
          </div>
        </div>
      `;
      
      container.querySelectorAll('.scp-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
          currentTab = e.currentTarget.getAttribute('data-tab');
          renderContent();
        });
      });
    };
    
    renderContent();
  },

  // View 3: Cost per accepted outcome
  async renderCostPerOutcome() {
    const container = document.getElementById('scp-outcomes-content');
    container.innerHTML = `<div class="text-center mt-4">Loading outcome data...</div>`;
    
    const data = await this.fetchCostPerOutcome();
    
    // Sort by cost/success desc
    data.sort((a, b) => b.costPerSuccess - a.costPerSuccess);
    
    const rowsHtml = data.map(item => {
      const trendColor = item.trend === 'improving' ? 'var(--success)' : (item.trend === 'degrading' ? 'var(--danger)' : 'var(--text-primary)');
      return `
        <tr>
          <td>${item.episodeType}</td>
          <td>$${item.totalCost.toLocaleString()}</td>
          <td>${item.successful.toLocaleString()}</td>
          <td style="color: ${trendColor}; font-weight: 600;">$${item.costPerSuccess.toFixed(2)}</td>
          <td>$${item.costPerFailure.toFixed(2)}</td>
          <td>${item.quality.toFixed(1)} / 5.0</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <div class="card glass-panel">
        <div class="card-header">
          <h3>Cost per Accepted Outcome</h3>
          <button class="btn secondary">Configure Episodes</button>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Episode Type</th>
                <th>Total Cost</th>
                <th>Successful</th>
                <th>Cost/Success</th>
                <th>Cost/Failure</th>
                <th>Quality Score</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </div>
    `;
  },

  // View 4: Budgets & consumption
  async renderBudgets() {
    const container = document.getElementById('scp-budgets-content');
    container.innerHTML = `<div class="text-center mt-4">Loading budgets...</div>`;
    
    const data = await this.fetchBudgets();
    
    const cardsHtml = data.map(item => {
      const pct = (item.spent / item.budget) * 100;
      let colorClass = 'green';
      if (pct >= 90) colorClass = 'red';
      else if (pct >= 75) colorClass = 'yellow';
      
      let badgeClass = item.status.toLowerCase().replace(' ', '-');
      
      return `
        <div class="card glass-panel mb-4">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px;">
            <div>
              <h3 style="margin-bottom: 4px;">${item.name}</h3>
              <div class="scp-badge ${badgeClass}">${item.status}</div>
              ${item.circuitOpen ? '<div class="scp-badge circuit-open" style="margin-left: 8px;">CIRCUIT OPEN</div>' : ''}
            </div>
            <div>
              <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                <input type="checkbox" ${item.circuitOpen ? '' : 'checked'} style="width:16px;height:16px;">
                <span style="font-size: 0.9rem; font-weight: 500;">Enforce</span>
              </label>
            </div>
          </div>
          
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 0.9rem;">
            <span>$${item.spent.toLocaleString()} spent</span>
            <span>$${item.budget.toLocaleString()} budget</span>
          </div>
          <div class="scp-progress-bar">
            <div class="scp-progress-fill ${colorClass}" style="width: ${Math.min(pct, 100)}%;"></div>
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = `
      <div class="card-header">
        <h3>Budgets & Consumption</h3>
        <button class="btn primary">Create Budget Policy</button>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 24px;">
        ${cardsHtml}
      </div>
    `;
  },

  // View 5: Alerts & prevented overspending
  async renderAlerts() {
    const container = document.getElementById('scp-alerts-content');
    container.innerHTML = `<div class="text-center mt-4">Loading alerts...</div>`;
    
    const data = await this.fetchAlerts();
    
    let currentFilter = 'All';
    
    const renderContent = () => {
      const filteredLogs = currentFilter === 'All' 
        ? data.logs 
        : data.logs.filter(l => 
            (currentFilter === 'Paused' && l.action === 'pause') ||
            (currentFilter === 'Routed' && l.action === 'route') ||
            (currentFilter === 'Alerts' && l.action === 'alert')
          );
      
      const rowsHtml = filteredLogs.map(l => {
        const date = new Date(l.timestamp).toLocaleString();
        return `
          <tr>
            <td>${date}</td>
            <td>${l.scope}</td>
            <td>${l.rule}</td>
            <td><span class="scp-action-chip scp-action-${l.action}">${l.action.toUpperCase()}</span></td>
            <td>${l.avoided > 0 ? '$' + l.avoided.toFixed(2) : '-'}</td>
          </tr>
        `;
      }).join('');

      container.innerHTML = `
        <div class="card glass-panel mb-4">
          <div class="card-header">
            <h3>Action Summary</h3>
            <div style="font-size: 1.2rem; font-weight: 600; color: var(--success);">
              $${data.totalValuePrevented.toLocaleString()} Total Value Prevented
            </div>
          </div>
          <div style="display: flex; gap: 24px; flex-wrap: wrap;">
            <div style="flex: 1; min-width: 150px; padding: 16px; background: rgba(255,255,255,0.02); border-radius: 8px; text-align: center;">
              <div style="font-size: 2rem; font-weight: 700; color: var(--success);">${data.summary.allow.toLocaleString()}</div>
              <div style="color: var(--text-secondary); font-size: 0.85rem; text-transform: uppercase;">Allowed</div>
            </div>
            <div style="flex: 1; min-width: 150px; padding: 16px; background: rgba(255,255,255,0.02); border-radius: 8px; text-align: center;">
              <div style="font-size: 2rem; font-weight: 700; color: var(--warning);">${data.summary.alert.toLocaleString()}</div>
              <div style="color: var(--text-secondary); font-size: 0.85rem; text-transform: uppercase;">Alerted</div>
            </div>
            <div style="flex: 1; min-width: 150px; padding: 16px; background: rgba(255,255,255,0.02); border-radius: 8px; text-align: center;">
              <div style="font-size: 2rem; font-weight: 700; color: #3b82f6;">${data.summary.route.toLocaleString()}</div>
              <div style="color: var(--text-secondary); font-size: 0.85rem; text-transform: uppercase;">Routed</div>
            </div>
            <div style="flex: 1; min-width: 150px; padding: 16px; background: rgba(255,255,255,0.02); border-radius: 8px; text-align: center;">
              <div style="font-size: 2rem; font-weight: 700; color: var(--danger);">${data.summary.pause.toLocaleString()}</div>
              <div style="color: var(--text-secondary); font-size: 0.85rem; text-transform: uppercase;">Paused</div>
            </div>
          </div>
        </div>

        <div class="card glass-panel">
          <div class="card-header">
            <h3>Chronological Action Log</h3>
            <div style="display: flex; gap: 8px;">
              ${['All', 'Paused', 'Routed', 'Alerts'].map(f => 
                `<button class="btn ${currentFilter === f ? 'primary' : 'secondary'} filter-btn" data-filter="${f}">${f}</button>`
              ).join('')}
            </div>
          </div>
          <div class="table-responsive">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Scope</th>
                  <th>Rule Triggered</th>
                  <th>Action Taken</th>
                  <th>Cost Avoided</th>
                </tr>
              </thead>
              <tbody>
                ${rowsHtml || '<tr><td colspan="5" class="text-center">No logs matching filter.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      `;
      
      container.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          currentFilter = e.currentTarget.getAttribute('data-filter');
          renderContent();
        });
      });
    };
    
    renderContent();
  },

  // View 6: Quality-tested recommendations
  async renderOptimizations() {
    const container = document.getElementById('scp-optimizations-content');
    container.innerHTML = `<div class="text-center mt-4">Loading optimizations...</div>`;
    
    const data = await this.fetchOptimizations();
    
    const pendingHtml = data.pending.map(opt => `
      <div class="card glass-panel mb-4" style="border: 1px solid var(--warning);">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px;">
          <div>
            <h3 style="margin-bottom: 8px; display: flex; align-items: center; gap: 12px;">
              ${opt.beforeModel} <span style="color:var(--text-secondary)">→</span> ${opt.afterModel}
              <span class="scp-badge warning">Pending Approval</span>
            </h3>
            <p style="color: var(--text-secondary); font-size: 0.9rem;">Cost Reduction: <span style="color: var(--success); font-weight: 600;">${opt.costReduction}%</span> | Projected Annual Savings: <span style="color: var(--success); font-weight: 600;">$${opt.annualSavings.toLocaleString()}</span></p>
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn primary" style="background: var(--success);">Approve</button>
            <button class="btn secondary">Reject</button>
          </div>
        </div>
        
        <div style="background: rgba(0,0,0,0.2); padding: 16px; border-radius: 8px; display: flex; gap: 32px;">
          <div>
            <div style="font-size: 0.85rem; color: var(--text-secondary); text-transform: uppercase;">Quality Before</div>
            <div style="font-size: 1.5rem; font-weight: 600;">${opt.qualityBefore} / 5.0</div>
          </div>
          <div>
            <div style="font-size: 0.85rem; color: var(--text-secondary); text-transform: uppercase;">Quality After</div>
            <div style="font-size: 1.5rem; font-weight: 600; color: ${opt.qualityAfter >= opt.qualityBefore ? 'var(--success)' : 'var(--warning)'};">${opt.qualityAfter} / 5.0</div>
          </div>
          <div style="flex-grow: 1; text-align: right;">
            <button class="btn secondary" style="font-size: 0.8rem; padding: 6px 12px;">View Proof Report</button>
          </div>
        </div>
      </div>
    `).join('');

    const activeHtml = data.active.map(opt => `
      <tr>
        <td>${opt.beforeModel} → ${opt.afterModel}</td>
        <td>${opt.qualityBefore} → ${opt.qualityAfter}</td>
        <td style="color: var(--success);">${opt.costReduction}%</td>
        <td style="color: var(--success);">$${opt.annualSavings.toLocaleString()}</td>
        <td><button class="btn secondary" style="font-size: 0.75rem; padding: 4px 8px;">Revert</button></td>
      </tr>
    `).join('');

    container.innerHTML = `
      <div class="card-header">
        <h3>Optimization Recommendations</h3>
        <button class="btn primary">Run New Comparison</button>
      </div>
      
      <div style="margin-bottom: 32px;">
        <h4 style="margin-bottom: 16px;">Pending Approvals</h4>
        ${pendingHtml || '<p style="color: var(--text-secondary);">No pending recommendations.</p>'}
      </div>
      
      <div class="card glass-panel">
        <div class="card-header">
          <h3>Active Approved Routings</h3>
        </div>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>Routing Rule</th>
                <th>Quality Shift</th>
                <th>Cost Reduction</th>
                <th>Annual Savings</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${activeHtml || '<tr><td colspan="5" class="text-center">No active routings.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }
};
