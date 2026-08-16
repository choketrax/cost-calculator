const fs = require('fs');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync('frontend/index.html', 'utf-8');
const script = fs.readFileSync('frontend/js/app.js', 'utf-8');

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  resources: "usable"
});

// Mock localStorage and fetch
dom.window.localStorage = {
  getItem: () => "container-internal",
  setItem: () => {}
};

dom.window.fetch = async (url) => {
  console.log("Fetch called:", url);
  if (url.includes("/health")) {
    return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
  }
  if (url.includes("/audits/?limit=5")) {
    return { 
      ok: true, status: 200, 
      json: async () => ({ 
        status: "ok", 
        data: [{
          audit_id: "test", 
          total_records: 3, 
          baseline_monthly_cost: "0.03"
        }] 
      }) 
    };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

// Catch errors
dom.window.addEventListener('error', (event) => {
  console.error("UI ERROR:", event.error);
});

dom.window.addEventListener('unhandledrejection', (event) => {
  console.error("UNHANDLED PROMISE REJECTION:", event.reason);
});

// Inject script
const scriptEl = dom.window.document.createElement('script');
scriptEl.textContent = script;
dom.window.document.body.appendChild(scriptEl);

console.log("Script injected. Waiting for DOMContentLoaded...");
dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

setTimeout(() => {
  console.log("Test finished.");
}, 2000);
