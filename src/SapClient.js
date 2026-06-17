/**
 * SapClient.gs — SAP S/4HANA Cloud OData (V2) client
 * ===================================================
 * - Basic Auth จาก Script Properties (ผ่าน getSapCredentials_ ใน Config.gs)
 * - Retry สูงสุด CFG.MAX_RETRIES ครั้ง พร้อม exponential backoff (เฉพาะ 429/5xx/network)
 * - CSRF token + session cookie สำหรับ write call (POST/PATCH)
 * - DRY_RUN gate: sapPost/sapPatch จะ log แล้ว return โดยไม่ยิง SAP
 * - ทุก call บันทึก EventLog: timestamp, function, endpoint, status, responseTime
 */

let _csrfCache_ = null; // { token, cookieStr, servicePath, fetchedAt }

// ============================================================================
// Logging
// ============================================================================

function logEvent(fn, endpoint, status, responseTimeMs, note) {
  try {
    getSheet_(CFG.SHEETS.EVENT_LOG).appendRow(
      [new Date(), fn, endpoint, String(status), responseTimeMs || 0, (note || '').slice(0, 500)]);
  } catch (e) {
    console.error('logEvent failed: ' + e.message); // log ห้ามทำให้ flow หลักล้ม
  }
}

function logError(fn, endpoint, message, payloadSnippet) {
  try {
    getSheet_(CFG.SHEETS.ERROR_LOG).appendRow(
      [new Date(), fn, endpoint, (message || '').slice(0, 1000), (payloadSnippet || '').slice(0, 500)]);
  } catch (e) {
    console.error('logError failed: ' + e.message);
  }
  console.error('[' + fn + '] ' + endpoint + ' → ' + message);
}

// ============================================================================
// URL / request core
// ============================================================================

/** ประกอบ URL — รองรับทั้ง relative path และ absolute URL (จาก __next) */
function buildSapUrl_(path, params) {
  const creds = getSapCredentials_();
  const base = path.indexOf('http') === 0 ? path : CFG.SAP_BASE_URL + path;
  const qp = Object.assign({}, params || {});
  if (creds.client) qp['sap-client'] = creds.client;

  const qs = Object.keys(qp)
    .map(function (k) { return k + '=' + encodeURIComponent(qp[k]); })
    .join('&');
  if (!qs) return base;
  return base + (base.indexOf('?') === -1 ? '?' : '&') + qs;
}

/**
 * Core HTTP — retry CFG.MAX_RETRIES ครั้ง, backoff 1s/2s/4s
 * retry เฉพาะ: network error, 429, 5xx และ 403 CSRF (write เท่านั้น — refresh token แล้วยิงใหม่)
 * @return {HTTPResponse}
 */
function sapRequest_(method, path, params, payload, extraHeaders, fnName) {
  const creds = getSapCredentials_();
  const fn = fnName || ('sap' + method.toUpperCase());
  const headers = Object.assign({
    'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
    'Accept': 'application/json'
  }, extraHeaders || {});

  const options = {
    method: method,
    headers: headers,
    muteHttpExceptions: true,
    followRedirects: true,
    validateHttpsCertificates: true
  };
  if (payload !== undefined && payload !== null) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }

  const url = buildSapUrl_(path, params);
  const endpointForLog = path.split('?')[0];
  let lastError = null;

  for (let attempt = 1; attempt <= CFG.MAX_RETRIES; attempt++) {
    const t0 = Date.now();
    let resp, code;
    try {
      resp = UrlFetchApp.fetch(url, options);
      code = resp.getResponseCode();
    } catch (netErr) { // network/timeout
      logEvent(fn, endpointForLog, 'NETWORK_ERR', Date.now() - t0, 'attempt ' + attempt + ': ' + netErr.message);
      lastError = netErr;
      Utilities.sleep(CFG.RETRY_BASE_MS * Math.pow(2, attempt - 1));
      continue;
    }

    const ms = Date.now() - t0;
    logEvent(fn, endpointForLog, code, ms, 'attempt ' + attempt);

    if (code >= 200 && code < 300) return resp;

    const body = resp.getContentText().slice(0, 800);

    // CSRF token หมดอายุ (write call) → ล้าง cache, refresh แล้ว retry
    if (code === 403 && method !== 'get' && /csrf/i.test(body + (resp.getAllHeaders()['x-csrf-token'] || ''))) {
      _csrfCache_ = null;
      const fresh = fetchCsrfToken(_lastServicePath_ || guessServicePath_(path));
      options.headers['x-csrf-token'] = fresh.token;
      options.headers['Cookie'] = fresh.cookieStr;
      lastError = new Error('CSRF expired, refreshed (attempt ' + attempt + ')');
      continue;
    }

    // Retryable: rate limit / server error
    if (code === 429 || code >= 500) {
      lastError = new Error('SAP HTTP ' + code + ': ' + body);
      Utilities.sleep(CFG.RETRY_BASE_MS * Math.pow(2, attempt - 1));
      continue;
    }

    // 4xx อื่น ๆ — retry ไปก็เท่านั้น โยน error พร้อม body ให้วิเคราะห์
    logError(fn, endpointForLog, 'HTTP ' + code + ': ' + body, options.payload || '');
    throw new Error('SAP HTTP ' + code + ' [' + endpointForLog + ']: ' + body);
  }

  logError(fn, endpointForLog, 'Failed after ' + CFG.MAX_RETRIES + ' attempts: ' + (lastError && lastError.message), '');
  throw lastError || new Error('SAP request failed after retries');
}

/** เดา service root จาก entity path เช่น /sap/opu/odata/sap/API_X_SRV/A_Entity → .../API_X_SRV/ */
function guessServicePath_(path) {
  const m = path.match(/^(.*\/odata\/sap\/[^\/]+\/)/);
  return m ? m[1] : path;
}

let _lastServicePath_ = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * GET 1 page — return parsed JSON (OData V2: { d: { results: [...], __next } })
 */
function sapGet(path, params, fnName) {
  const p = Object.assign({ '$format': 'json' }, params || {});
  const resp = sapRequest_('get', path, p, null, null, fnName || 'sapGet');
  return JSON.parse(resp.getContentText() || '{}');
}

/**
 * GET ทุก page — ตาม __next link จนหมด
 * Fallback: ถ้า SAP ไม่ส่ง __next ใช้ $skip offset แทน (server-driven vs client-driven paging)
 * กัน infinite loop ที่ MAX_PAGES = 200 pages (200 records/page × 200 pages = 40,000 records max)
 */
function sapGetAllResults(path, params, fnName) {
  const fn = fnName || 'sapGetAllResults';
  const MAX_PAGES = 200;
  const pageSize = CFG.PAGE_SIZE;

  // First page — ขอ inline count เพื่อรู้จำนวนจริง
  const p = Object.assign(
    { '$top': String(pageSize), '$inlinecount': 'allpages' },
    params || {}
  );

  let results = [];
  let data = sapGet(path, p, fn);
  let guard = 0;

  while (guard++ < MAX_PAGES) {
    const d = data.d || {};
    const pageResults = d.results || [];
    results = results.concat(pageResults);

    const totalCount = parseInt(d.__count || '0', 10);
    if (totalCount > 0 && guard === 1) {
      console.log('[sapGetAllResults] totalCount=' + totalCount +
                  ' pageSize=' + pageSize +
                  ' estimatedPages=' + Math.ceil(totalCount / pageSize));
    }

    // SAP ส่ง __next → ใช้ server-driven paging (preferred)
    if (d.__next) {
      const resp = sapRequest_('get', d.__next, null, null, null, fn + '[next' + guard + ']');
      data = JSON.parse(resp.getContentText() || '{}');
      continue;
    }

    // ไม่มี __next: ถ้าได้ครบ pageSize → ยังมีหน้าถัดไป ใช้ $skip
    if (pageResults.length < pageSize) break; // หน้าสุดท้ายแล้ว

    // Client-driven paging ด้วย $skip
    const skip = guard * pageSize;
    const skipParams = Object.assign({}, params || {}, {
      '$top': String(pageSize),
      '$skip': String(skip),
      '$inlinecount': 'allpages'
    });
    console.log('[sapGetAllResults] $skip fallback page=' + (guard+1) + ' skip=' + skip +
                ' collected=' + results.length);
    data = sapGet(path, skipParams, fn + '[skip' + guard + ']');
  }

  console.log('[sapGetAllResults] done: total collected=' + results.length);
  return results;
}

/**
 * ขอ CSRF token + session cookies จาก service root (จำเป็นก่อน POST/PATCH ทุกครั้ง)
 * cache ไว้ใน execution เดียวกัน — refresh อัตโนมัติเมื่อเจอ 403 CSRF
 */
function fetchCsrfToken(servicePath) {
  if (_csrfCache_ && _csrfCache_.servicePath === servicePath) return _csrfCache_;

  const creds = getSapCredentials_();
  const t0 = Date.now();
  const resp = UrlFetchApp.fetch(buildSapUrl_(servicePath, { '$format': 'json' }), {
    method: 'get',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'x-csrf-token': 'Fetch',
      'Accept': 'application/json'
    },
    muteHttpExceptions: true
  });

  const code = resp.getResponseCode();
  const h = resp.getAllHeaders();
  const token = h['x-csrf-token'] || h['X-CSRF-Token'];
  let setCookies = h['Set-Cookie'] || [];
  if (typeof setCookies === 'string') setCookies = [setCookies];
  const cookieStr = setCookies.map(function (c) { return c.split(';')[0]; }).join('; ');

  logEvent('fetchCsrfToken', servicePath, code, Date.now() - t0, token ? 'token OK' : 'NO TOKEN');
  if (code < 200 || code >= 300 || !token) {
    logError('fetchCsrfToken', servicePath, 'HTTP ' + code + ' / token=' + token, '');
    throw new Error('CSRF token fetch failed (HTTP ' + code + ') — ตรวจ credential / comm arrangement');
  }

  _csrfCache_ = { token: token, cookieStr: cookieStr, servicePath: servicePath, fetchedAt: Date.now() };
  _lastServicePath_ = servicePath;
  return _csrfCache_;
}

/**
 * POST (write) — เคารพ DRY_RUN: log payload แล้วจบ ไม่แตะ SAP
 * @param {Object} opts { servicePath, params, fnName }
 */
function sapPost(path, payload, opts) {
  opts = opts || {};
  const fn = opts.fnName || 'sapPost';
  const endpoint = path.split('?')[0];

  if (CFG.DRY_RUN) {
    logEvent(fn + '[DRY_RUN]', endpoint, 'SKIPPED', 0,
      'would POST: ' + JSON.stringify(payload).slice(0, 400));
    return { dryRun: true, endpoint: endpoint, payload: payload };
  }

  const servicePath = opts.servicePath || guessServicePath_(path);
  const csrf = fetchCsrfToken(servicePath);
  const resp = sapRequest_('post', path, opts.params, payload, {
    'x-csrf-token': csrf.token,
    'Cookie': csrf.cookieStr
  }, fn);
  return JSON.parse(resp.getContentText() || '{}');
}

/**
 * PATCH (update) — เคารพ DRY_RUN เช่นเดียวกับ sapPost (ใช้ Phase 3-4)
 * SAP V2 บางครั้งต้องใช้ POST + X-HTTP-Method: MERGE — รองรับผ่าน opts.useMerge
 */
function sapPatch(path, payload, opts) {
  opts = opts || {};
  const fn = opts.fnName || 'sapPatch';
  const endpoint = path.split('?')[0];

  if (CFG.DRY_RUN) {
    logEvent(fn + '[DRY_RUN]', endpoint, 'SKIPPED', 0,
      'would PATCH: ' + JSON.stringify(payload).slice(0, 400));
    return { dryRun: true, endpoint: endpoint, payload: payload };
  }

  const servicePath = opts.servicePath || guessServicePath_(path);
  const csrf = fetchCsrfToken(servicePath);
  const headers = { 'x-csrf-token': csrf.token, 'Cookie': csrf.cookieStr };
  let method = 'patch';
  if (opts.useMerge) { method = 'post'; headers['X-HTTP-Method'] = 'MERGE'; }

  const resp = sapRequest_(method, path, opts.params, payload, headers, fn);
  const txt = resp.getContentText();
  return txt ? JSON.parse(txt) : { status: resp.getResponseCode() }; // 204 No Content
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Probe — fetch service $metadata to confirm entity names and navigation properties.
 * Run this ONCE after clasp push to verify field names against live EDMX.
 * Output goes to console log only — no sheet writes.
 */
function probeServiceMetadata() {
  const creds = getSapCredentials_();
  const url = CFG.SAP_BASE_URL + CFG.SERVICES.PRODUCTION_ORDERS + '$metadata';
  const t0 = Date.now();
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'Accept': 'application/xml'
    },
    muteHttpExceptions: true
  });
  const code = resp.getResponseCode();
  const body = resp.getContentText();
  logEvent('probeServiceMetadata', url, code, Date.now() - t0,
    code === 200 ? 'EDMX length=' + body.length : body.slice(0, 300));
  console.log('HTTP ' + code);
  if (code === 200) {
    const entityTypeMatches = body.match(/EntityType Name="[^"]+"/g) || [];
    const entitySetMatches  = body.match(/EntitySet Name="[^"]+"/g) || [];
    const navMatches        = body.match(/NavigationProperty Name="[^"]+"/g) || [];
    console.log('=== EntityTypes ===\n'  + entityTypeMatches.join('\n'));
    console.log('=== EntitySets ===\n'   + entitySetMatches.join('\n'));
    console.log('=== NavigationProperties ===\n' + navMatches.join('\n'));
  }
  return code;
}

/**
 * Probe fields of A_ProductionOrder_2 entity from $metadata XML
 * Run once to get exact Property names before fixing PO_SELECT_
 */
function probeEntityFields() {
  const creds = getSapCredentials_();
  const url = CFG.SAP_BASE_URL + CFG.SERVICES.PRODUCTION_ORDERS + '$metadata';
  const resp = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
      'Accept': 'application/xml'
    },
    muteHttpExceptions: true
  });
  const body = resp.getContentText();

  // Extract A_ProductionOrder_2Type entity block only
  const entityBlock = body.match(
    /EntityType Name="A_ProductionOrder_2Type"[\s\S]*?<\/EntityType>/
  );
  if (!entityBlock) {
    console.log('A_ProductionOrder_2Type block not found');
    return;
  }
  const props = entityBlock[0].match(/Property Name="[^"]+"/g) || [];
  console.log('=== A_ProductionOrder_2 Properties (' + props.length + ') ===');
  console.log(props.join('\n'));
}

/** แปลง OData V2 date "/Date(1718150400000)/" → JS Date (null-safe) */
function parseSapDate_(v) {
  if (!v) return '';
  const m = String(v).match(/\/Date\((-?\d+)/);
  return m ? new Date(parseInt(m[1], 10)) : v;
}

/** สำหรับ Test Gate: ping SAP ด้วย GET เบา ๆ ($top=1) เช็ก credential + connectivity */
function testSapConnection() {
  // Use $top=1 with NO $select first — confirms EntitySet reachable
  const data = sapGet(CFG.ENDPOINTS.PRODUCTION_ORDERS,
    { '$top': '1' }, 'testSapConnection');
  const results = (data.d || {}).results || [];
  const n = results.length;
  if (n > 0) {
    console.log('SAP connection OK — sample row keys: ' + Object.keys(results[0]).join(', '));
  } else {
    console.log('SAP connection OK — 0 rows returned (check Plant filter or date range)');
  }
  return n;
}

// ============================================================================
// Phase 3 — CSRF session helper (explicit token+cookie pair, no shared cache)
// ============================================================================

/**
 * ขอ CSRF token + session cookie เป็น "คู่เดียวกัน" จาก service root เดียวกัน (GET เดียว)
 * ต่างจาก fetchCsrfToken(): ไม่ cache, ไม่ผูกกับ sapPost/sapPatch — ใช้เมื่อ caller
 * ต้องการ token+cookie สด ๆ ของตัวเอง (เช่น flow POST แยกของ Order Confirmation)
 *
 * GAS UrlFetchApp ไม่ persist cookie ข้าม call — ต้องอ่าน Set-Cookie จาก response นี้
 * แล้วแนบกลับเป็น header "Cookie" เองตอนยิง POST/PATCH ที่ใช้ token นี้
 *
 * @param {string} serviceUrl - OData service root แบบเต็ม URL หรือ relative path เช่น
 *   '/sap/opu/odata/sap/API_PROD_ORDER_CONFIRMATION_2_SRV/'
 * @return {{token: string, cookies: string}} token ดิบ และ cookie string เดียว
 *   (รวมหลาย cookie ด้วย "; " — แต่ละตัวเก็บเฉพาะส่วนก่อน ';' แรก)
 * @throws {Error} ถ้า HTTP status ไม่ใช่ 2xx หรือ token หายไป/เป็น "" / "Required"
 */
function getCsrfSession_(serviceUrl) {
  const t0 = Date.now();
  try {
    const creds = getSapCredentials_();
    const url = buildSapUrl_(serviceUrl);
    const resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'Authorization': 'Basic ' + Utilities.base64Encode(creds.user + ':' + creds.pass),
        'X-CSRF-Token': 'Fetch',
        'Accept': 'application/json'
      },
      muteHttpExceptions: true
    });

    const code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      throw new Error('HTTP ' + code + ' fetching CSRF token [' + serviceUrl + ']');
    }

    // SAP มักส่ง header เป็น lowercase "x-csrf-token" — ห้าม assume key casing ตายตัว
    const allHeaders = resp.getAllHeaders();
    let token = null;
    let setCookieRaw = null;
    Object.keys(allHeaders).forEach(function (k) {
      const lk = k.toLowerCase();
      if (lk === 'x-csrf-token') token = allHeaders[k];
      if (lk === 'set-cookie') setCookieRaw = allHeaders[k];
    });

    if (!token || token === '' || token === 'Required') {
      throw new Error('CSRF token missing or "Required" — fetch failed [' + serviceUrl + ']');
    }

    // Set-Cookie อาจเป็น string เดียวหรือ array (ขึ้นกับจำนวน cookie ที่ SAP set) — normalize
    // เป็น array เดียวกันก่อน แล้วเก็บเฉพาะส่วนก่อน ';' แรกของแต่ละ cookie (ตัด attribute ทิ้ง)
    let cookieArr = [];
    if (Array.isArray(setCookieRaw)) cookieArr = setCookieRaw;
    else if (typeof setCookieRaw === 'string' && setCookieRaw) cookieArr = [setCookieRaw];
    const cookies = cookieArr.map(function (c) { return String(c).split(';')[0].trim(); }).join('; ');

    // ห้าม log ค่า token/cookie เต็ม — เป็น session secret, log แค่ length/count
    logEvent('getCsrfSession_', serviceUrl, 'OK', Date.now() - t0,
      'tokenLen=' + token.length + ' cookies=' + cookieArr.length);

    return { token: token, cookies: cookies };

  } catch (err) {
    logEvent('getCsrfSession_', serviceUrl, 'ERROR', Date.now() - t0, err.message);
    throw err;
  }
}

/**
 * ทดสอบ getCsrfSession_() กับ API_PROD_ORDER_CONFIRMATION_2_SRV (Phase 3 — Order Confirmation)
 * รันจาก editor Run dropdown เพื่อ verify credential + CSRF handshake ก่อนต่อ POST จริง
 * Log เฉพาะข้อมูลปลอดภัย: token length, 4 ตัวอักษรแรกของ token, จำนวน cookie, ชื่อ cookie —
 * ห้าม log ค่า token/cookie เต็ม
 */
function testCsrfSession() {
  const serviceUrl = CFG.SAP_BASE_URL + CFG.SERVICES.PROD_ORDER_CONF;
  try {
    const session = getCsrfSession_(serviceUrl);
    const cookieNames = session.cookies
      ? session.cookies.split(';').map(function (c) { return c.split('=')[0].trim(); })
      : [];
    Logger.log('CSRF session OK — tokenLen=' + session.token.length +
      ' tokenPrefix=' + session.token.slice(0, 4) +
      ' cookieCount=' + cookieNames.length +
      ' cookieNames=[' + cookieNames.join(', ') + ']');
  } catch (err) {
    Logger.log('testCsrfSession FAILED: ' + err.message);
  }
}
