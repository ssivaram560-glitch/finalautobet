const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const crypto      = require('crypto');
const zlib        = require('zlib');
const puppeteer   = require('puppeteer');

// ============================================================
//  CONFIG
// ============================================================
const BOT_TOKEN    = "8692459169:AAFW_sv72xScUpn0xFsaPTCuzJpNLO0EIBU";
const OWNER_ID     = 8321379592;
const OWNER_PASS   = "2004";
const ADMIN_HANDLE = "@OnlineEarningapp_bot";
const REG_LINK     = "https://bdgwinuu.com/#/register?invitationCode=6435414007795";
const WIN_STICKER  = "CAACAgUAAxkBAAFHUGNp4JX1-ohP4uBEWpfNptaz-HmwVgAC4hgAAhboKVbObuGuTcMs2zsE";
const LOSS_STICKER = "CAACAgUAAxkBAAFHUGVp4JX-BE2TRkhIKTwcjkwW-gzdPAACthoAAoG8YVYiydObSa0O8zsE";

const BET_URL     = "https://api.ar-lottery01.com/api/Lottery/WinGoBet";
const LOGIN_URL   = "https://api.bdg88zf.com/api/webapi/Login";
const CAPTCHA_URL = "https://api.bdg88zf.com/api/webapi/GetCaptcha";
const DRAW_URL    = "https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json";

// Martingale multipliers — user can customize base bet
const MULT = [1, 3, 9, 27, 81, 243, 729, 2187, 6561, 19683]; // Standard 3x Martingale multipliers

// ============================================================
//  RENDER KEEP-ALIVE
// ============================================================
const http = require('http');
const PORT = process.env.PORT || 5000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('SIVA BOT OK');
}).listen(PORT, () => console.log(`✅ Keep-alive server on port ${PORT}`));

const RENDER_URL = process.env.RENDER_URL || "";
if (RENDER_URL) {
    setInterval(() => {
        axios.get(RENDER_URL).catch(() => {});
        console.log("[PING] Keep-alive ping sent");
    }, 14 * 60 * 1000);
}

// ============================================================
//  STORAGE
// ============================================================
let ownerLoggedIn  = false;
let adminPasswords = {};
let adminLoggedIn  = {};
let usersAccess    = {};
let keyStore       = {};
let stats          = {};
let running        = {};
let sentPeriods    = {};
let ownerState     = null;
let adminState   = {};
let userAction   = {}; 
let userCreds      = {};
let autobetCfg     = {};
let autobetState   = {};
let profitTrack    = {};
let GLOBAL_TOKEN   = "";
let userTokens = {}; 
let userStates = {};

// ============================================================
//  AUTO-LEVEL CORRECTION STORAGE (NEW)
// ============================================================
// skipAnalysisState: stores the state of skip+analysis mode after 3 losses
let skipAnalysisState = {};
/*
  skipAnalysisState[userId] = {
    mode: null | "SKIP" | "ANALYSIS",
    skipRemaining: 0,        // remaining skip periods
    analysisBuffer: [],      // last 4 results collected during analysis phase
    originalMode: null,      // mode before entering skip (SAME/OPPOSITE)
    originalHistory: [],     // history snapshot before skip started
    patternMatched: false,   // whether analysis matched the original pattern
    analysisCount: 0,        // how many periods analyzed so far
  }
*/

// ============================================================
//  LOGGING HELPER (New)
// ============================================================
async function logBoth(chatId, msg, isError = false) {
    if (isError) console.error(msg);
    else console.log(msg);
    if (chatId) {
        // Use the global bot instance if available
        if (bot) {
            try {
                await bot.sendMessage(chatId, msg);
            } catch (e) {
                // Ignore message sending errors to prevent loops
            }
        }
    }
}

// ============================================================
//  HELPERS
// ============================================================
async function fetchList() {
    try {
        const response = await axios.get(DRAW_URL, {
            headers: {
                "Accept": "application/json, text/plain, */*",
                "Origin": "https://bdgwin901.com",
                "Referer": "https://bdgwin901.com/",
                "Ar-Origin": "https://bdgwin901.com",
                "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
            },
            timeout: 10000
        });
        if (response.data && response.data.data && response.data.data.list) {
            return response.data.data.list;
        }
        return [];
    } catch (error) {
        console.error("[FETCH LIST ERROR]", error.message);
        return null;
    }
}
async function getLiveBalance(userId) {
    let token = getToken(userId);
    if (!token) return null;
    try {
        const r = await axios.get("https://api.bdg88zf.com/api/webapi/GetBalance", {
            headers: {
                "Authorization": "Bearer " + token,
                "Ar-Origin": "https://bdgwin901.com",
                "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36"
            }
        });
        if (r.data && r.data.code === 0) {
            return r.data.data.balance;
        }
        return null;
    } catch (e) {
        return null;
    }
}


function initUser(id) {
    if (!stats[id])        stats[id]        = { total:0,win:0,loss:0,lossStreak:0,winStreak:0,maxWinStreak:0,maxLossStreak:0 };
   if (!userStates[id])   userStates[id]   = { resultHistory:[], skipCount:0, currentMode:null, lastPrediction:null };
    if (!sentPeriods[id])  sentPeriods[id]  = new Set();
    if (!autobetCfg[id])   autobetCfg[id]   = { 
        watch:false, 
        watchLoss:5, 
        baseBet:1, 
        maxLvl:5, 
        enabled:false, 
        customBets:[1,3,9,27,81],
        targetProfit: 1000,    // NEW: Profit target set panna
        restartDelay: 1        // NEW: Restart time (hours) set panna
    };
    if (!autobetState[id]) autobetState[id] = { 
        level:1, 
        consecutiveLoss:0, 
        inMart:false,
        isWaiting: false,      // NEW: Bot waiting-la irukka-nu check panna
        nextStartTime: null    // NEW: Thirumba eppo start aakanum-nu store panna
    };
    if (!profitTrack[id])  profitTrack[id]  = { totalBets:0, wins:0, losses:0, pnl:0, winStreak:0, lossStreak:0, maxW:0, maxL:0, totalBetAmount: 0 };
    // Initialize skipAnalysisState
    if (!skipAnalysisState[id]) {
        skipAnalysisState[id] = {
            mode: null,
            skipRemaining: 0,
            analysisBuffer: [],
            originalMode: null,
            originalHistory: [],
            patternMatched: false,
            analysisCount: 0,
        };
    }
}

function hasAccess(id)  { return !!(usersAccess[id] && Date.now() < usersAccess[id]); }
function daysLeft(id)   { return usersAccess[id] ? ((usersAccess[id]-Date.now())/86400000).toFixed(1) : "0"; }
function isAdmin(id)    { return adminPasswords[id] !== undefined; }
function isAdminIn(id)  { return adminLoggedIn[id] === true; }
function sleep(ms)      { return new Promise(r => setTimeout(r, ms)); }
function getToken(id)   { return userTokens[id] || GLOBAL_TOKEN || ""; }

function generateKey(days, by) {
    const k = "EARN WITH ME-"+crypto.randomBytes(3).toString('hex').toUpperCase()+"-"+crypto.randomBytes(2).toString('hex').toUpperCase();
    keyStore[k] = { days, used:false, usedBy:null, by:by||OWNER_ID };
    return k;
}
function activateKey(userId, code) {
    const k = code.toUpperCase().trim();
    if (!keyStore[k])     return { ok:false, msg:"❌ Invalid key!" };
    if (keyStore[k].used) return { ok:false, msg:"❌ Key already used!" };
    const days = keyStore[k].days;
    keyStore[k].used=true; keyStore[k].usedBy=userId;
    const base = (usersAccess[userId]&&usersAccess[userId]>Date.now()) ? usersAccess[userId] : Date.now();
    usersAccess[userId] = base + days*86400000;
    return { ok:true, days, expiry:new Date(usersAccess[userId]).toLocaleString() };
}
function activeUsersList() {
    const now=Date.now(), list=Object.entries(usersAccess).filter(([,e])=>e>now);
    return list.length ? list.map(([id,e])=>"🟢 "+id+" | "+((e-now)/86400000).toFixed(1)+"d").join("\n") : "No active users.";
}
function adminList() {
    const ids=Object.keys(adminPasswords);
    return ids.length ? ids.map(id=>"👤 "+id+" | "+(adminLoggedIn[id]?"🟢 Online":"🔴 Offline")).join("\n") : "No admins.";
}
function allKeysList() {
    const keys=Object.entries(keyStore);
    return keys.length ? keys.map(([k,v])=>k+" → "+(v.used?"✅ Used":"🟢 "+v.days+"d")).join("\n") : "No keys.";
}

// ============================================================
//  DEVICE ID
// ============================================================
function getOrCreateDevice(userId) {
    if (!userCreds[userId]) userCreds[userId] = {};
    if (!userCreds[userId].deviceId) {
        userCreds[userId].deviceId = crypto.randomBytes(16).toString('hex');
    }
    return userCreds[userId].deviceId;
}

// ============================================================
//  SIGNATURES
// ============================================================
function makeLoginSign(params) {
    const p = {...params};
    delete p.signature; delete p.timestamp; delete p.track;
    const keys = Object.keys(p).filter(k => {
        const v = p[k];
        if (v === null || v === undefined || v === "") return false;
        if (typeof v === 'object') return false;
        return true;
    }).sort();
    const sorted = {};
    keys.forEach(k => { sorted[k] = p[k]; });
    const str = JSON.stringify(sorted);
    const sig = crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0,32);
    return sig;
}

function makeBetSign(params) {
    const p = {...params};
    delete p.signature; delete p.timestamp;
    const keys = Object.keys(p).filter(k=>p[k]!==null&&p[k]!=="").sort();
    const sorted = {};
    keys.forEach(k=>{ sorted[k]=p[k]===0?0:p[k]; });
    return crypto.createHash('md5').update(JSON.stringify(sorted)).digest('hex').toUpperCase().slice(0,32);
}

// ============================================================
//  FETCH CAPTCHA
// ============================================================
async function fetchCaptcha() {
    try {
        const r = await axios.get(CAPTCHA_URL, {
            headers: {
                "Accept": "application/json, text/plain, */*",
                "Origin": "https://bdgwin8.vip",
                "Referer": "https://bdgwin8.vip",
                "Ar-Origin": "https://bdgwin901.com",
                "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
            },
            timeout: 10000
        });
        if (r.data?.code===0 && r.data?.data?.captchaId) {
            return r.data.data.captchaId;
        }
        return "";
    } catch(e) {
        console.error("[CAPTCHA ERR]", e.message);
        return "";
    }
}

// ============================================================
//  AUTO LOGIN (PUPPETEER VERSION)
// ============================================================
let loginLock = {};

async function autoLogin(userId, chatId, silent = false) {
    if (loginLock[userId]) {
        await logBoth(chatId, `[AUTO LOGIN] User ${userId} already in login process.`);
        return false;
    }
    loginLock[userId] = true;

    const creds = userCreds[userId] || {};
    const { phone, pass } = creds;

    if (!phone || !pass) {
        await logBoth(chatId, `[AUTO LOGIN] User ${userId} has no phone or password set.`);
        loginLock[userId] = false;
        return false;
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true, 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--disable-gpu']
        });
        const page = await browser.newPage();
        await page.setDefaultNavigationTimeout(90000); 
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        let capturedToken = null;
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (req.url().includes('GetBalance') && req.headers()['authorization']) {
                capturedToken = req.headers()['authorization'].replace(/^Bearer\s+/i, "");
            }
            req.continue();
        });

        await page.goto('https://bdgwin901.com/#/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForSelector('input', { timeout: 30000 });
        const inputs = await page.$$('input');
        if (inputs.length < 2) throw new Error("Login inputs not found");

        await inputs[0].type(phone, { delay: 50 });
        await inputs[1].type(pass, { delay: 50 });
        
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const loginBtn = btns.find(b => b.innerText.includes('Log in') || b.innerText.includes('Login'));
            if (loginBtn) loginBtn.click();
            else document.querySelector('form')?.submit();
        });

        try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch (e) {
            // Ignore timeout, we'll check token anyway
        }
        await new Promise(r => setTimeout(r, 5000));

        await page.evaluate(() => {
            const closeBtn = document.querySelector('.van-icon-cross') || document.querySelector('.close-icon');
            if (closeBtn) closeBtn.click();
        });
        await new Promise(r => setTimeout(r, 1000));

        await page.evaluate(() => {
            const navItems = Array.from(document.querySelectorAll('div, span'));
            const lotteryBtn = navItems.find(el => el.innerText.trim() === 'Lottery');
            if (lotteryBtn) lotteryBtn.click();
        });
        await new Promise(r => setTimeout(r, 2000));

        await page.evaluate(() => {
            const navItems = Array.from(document.querySelectorAll('div, span'));
            const winGoBtn = navItems.find(el => el.innerText.trim() === 'Win Go');
            if (winGoBtn) winGoBtn.click();
        });

        for (let i = 0; i < 50; i++) {
            if (capturedToken) break;
            await new Promise(r => setTimeout(r, 1000));
        }

        if (capturedToken) {
            // Success: Update token only when captured
            userTokens[userId] = capturedToken;
            await logBoth(chatId, `✅ [SUCCESS] Token captured successfully for user ${userId}!`);
            return true;
        } else {
            throw new Error("Token not found in requests after login sequence.");
        }

    } catch (err) {
        await logBoth(chatId, `❌ Login Error for user ${userId}: ${err.message}`, true);
        return false;
    } finally {
        if (browser) await browser.close();
        loginLock[userId] = false;
    }
}

// ============================================================
//  ROBUST LOGIN WITH CONTINUOUS RETRY
// ============================================================
async function robustLogin(userId, chatId, silent = false) {
    let success = await autoLogin(userId, chatId, silent);
    if (!success && !silent && chatId) {
        await logBoth(chatId, "❌ Login failed. Will retry automatically.");
    }
    return success;
}

// ============================================================
//  PLACE BET
// ============================================================
// PLACE BET (Modified to capture token from response if available)
// ============================================================
// ============================================================374	//  IMPROVED PLACE BET FUNCTION (Si
// ============================================================
//  IMPROVED PLACE BET FUNCTION (Silent Retries & Multi-Request Fix)
// ============================================================
async function placeBet(userId, chatId, period, prediction, predType, level) {
    let token = getToken(userId);
    if (!token || token.length < 20) {
        console.log("[PLACE BET] Token missing or invalid, attempting autoLogin...");
        const ok = await autoLogin(userId, chatId, true);
        if (!ok) { 
            await send(chatId,"❌ Token இல்லை!\n/setcreds FULLPHONE PASSWORD"); 
            return false; 
        }
        token = getToken(userId);
    }

    const cfg     = autobetCfg[userId];
    const betMult = cfg.customBets[level-1] || (cfg.baseBet * MULT[level-1]);
    let bc = "";

    const maxRetries = 3; // Maximum number of retries
    const retryDelayMs = 2000; // 2 seconds delay between retries

    if (predType==="SIZE")  bc = prediction==="BIG" ? "BigSmall_Big" : "BigSmall_Small";
    if (predType==="COLOR") bc = prediction==="RED" ? "Color_Red"    : "Color_Green";

    const params = {
        amount:      1,
        betContent:  bc,
        betMultiple: betMult,
        gameCode:    "WinGo_30S", 
        issueNumber: String(period),
        language:    "en",
        random:      Math.floor(Math.random()*1e12)
    };
    const signature = makeBetSign(params);
    const timestamp = Math.floor(Date.now()/1000);
    const payload   = {...params, signature, timestamp};

    console.log(`[BET] ${bc} ₹${betMult} L${level} for Period: ${period}`);

    for (let i = 0; i < maxRetries; i++) {
        try {
        const r = await axios.post(BET_URL, payload, {
            headers: {
                "authorization":    "Bearer "+token,
                "content-type":     "application/json",
                "Accept":           "application/json, text/plain, */*",
                "Origin":           "https://bdgwin8.vip",
                "Referer":          "https://bdgwin8.vip/",
                "Ar-Origin":        "https://bdgwin8.vip",
                "Sec-Ch-Ua":        '"Chromium";v="139"',
                "Sec-Ch-Ua-Mobile": "?1",
                "Sec-Fetch-Dest":   "empty",
                "Sec-Fetch-Mode":   "cors",
                "Sec-Fetch-Site":   "cross-site",
                "User-Agent":       "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
            },
            timeout: 10000
        });
        const d = r.data;
        console.log(`[BET RESP] code:${d.code} msg:${d.msg}`);

        // Check for a new token in response headers (e.g., 'Authorization' or 'x-auth-token')
        const newTokenFromResponseHeader = r.headers['authorization'] || r.headers['x-auth-token'];
        if (newTokenFromResponseHeader) {
            const cleanNewToken = newTokenFromResponseHeader.replace(/^Bearer\s+/i, "");
            if (cleanNewToken !== token) {
                userTokens[userId] = cleanNewToken;
                console.log("[TOKEN UPDATE] New token captured from bet response headers!");
            }
        }

        // Also check if the token is in the response body
        if (d.data && d.data.token && d.data.token !== token) {
             userTokens[userId] = d.data.token;
             console.log("[TOKEN UPDATE] New token captured from bet response body!");
        }

        if (d.code===0||d.msg==="Succeed"||d.msgCode===0) return {ok:true, amt:betMult, bc};

        const retryableErrors = ["Param is Invalid", "The issue number does not exist", "period current settled"];
        if (d.msg && retryableErrors.some(errStr => d.msg.toLowerCase().includes(errStr))) {
            console.log(`[BET RETRY] Retryable error: ${d.msg}. Retrying in ${retryDelayMs / 1000}s... (Attempt ${i + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
            continue; // Retry
        }

        if (d.code===401||d.code===40100||(d.msg&&(d.msg.toLowerCase().includes("token")||d.msg.toLowerCase().includes("expired")))) {
            
            await send(chatId,"🔄 Token expired — Re-login...");
            const ok = await autoLogin(userId,chatId,true);
            if(ok) await send(chatId,"✅ Re-login OK!");
            else   await send(chatId,"❌ Re-login fail! /setcreds பண்ணு.");
            return false;
        }

        await send(chatId,"❌ Bet fail: "+(d.msg||JSON.stringify(d).substr(0,60)));
        return false;
    } catch(err) {
        console.error("[BET ERR]",err.message);
        if (err.response && (err.response.status === 401 || (err.response.data && (err.response.data.msg && (err.response.data.msg.toLowerCase().includes("token") || err.response.data.msg.toLowerCase().includes("expired")))))) {
            
            await send(chatId,"🔄 Token error during bet — Re-login...");
            const ok = await autoLogin(userId,chatId,true);
            if(ok) await send(chatId,"✅ Re-login OK!");
            else   await send(chatId,"❌ Re-login fail! /setcreds பண்ணு.");
            return false;
        }
        await send(chatId,"❌ Network error during bet: "+err.message);
        return false;
    }
}
// If all retries fail, return false
return false;
}

// ============================================================
//  LOGIC (SAME / OPPOSITE MODE — 3 LEVEL)
// ============================================================

// ════════════════════════════════════════════════════════════════════
//  INIT STATE — Safe
// ════════════════════════════════════════════════════════════════════
function initState(userId) {
    if (!userStates[userId]) {
        userStates[userId] = {
            resultHistory: [],   // actual B/S results (oldest first)
            skipCount: 0,        // predictions to skip after L3 loss
            currentMode: null,   // "SAME" or "OPPOSITE"
            lastPrediction: null
        };
    }
    if (!Array.isArray(userStates[userId].resultHistory)) {
        userStates[userId].resultHistory = [];
    }
    if (typeof userStates[userId].skipCount !== "number") {
        userStates[userId].skipCount = 0;
    }
    // Ensure skipAnalysisState is initialized
    if (!skipAnalysisState[userId]) {
        skipAnalysisState[userId] = {
            mode: null,
            skipRemaining: 0,
            analysisBuffer: [],
            originalMode: null,
            originalHistory: [],
            patternMatched: false,
            analysisCount: 0,
        };
    }
}

// ════════════════════════════════════════════════════════════════════
//  BUILD B/S FROM API LIST (oldest first)
// ════════════════════════════════════════════════════════════════════
function buildBSFromList(list, count) {
    const recent = list.slice(0, Math.min(count, list.length));
    const seq = [];
    for (const item of recent) {
        const n = parseInt(item.number || item.winNumber || 0);
        if (!isNaN(n)) {
            seq.push(n >= 5 ? "B" : "S");
        }
    }
    return seq.reverse(); // Returns oldest to newest
}

/**
 * Determines the current trend mode (SAME or OPPOSITE)
 */
function getModeFromLast2(resultHistory) {
    if (resultHistory.length < 2) return null;
    const len = resultHistory.length;
    const secondLast = resultHistory[len - 2];
    const last = resultHistory[len - 1];
    return secondLast === last ? "SAME" : "OPPOSITE";
}

/**
 * Predicts the next result based on the detected mode
 */
function getPredictionFromMode(resultHistory, mode) {
    if (resultHistory.length < 1) return null;
    const last = resultHistory[resultHistory.length - 1];
    if (mode === "SAME") return last === "B" ? "BIG" : "SMALL";
    if (mode === "OPPOSITE") return last === "B" ? "SMALL" : "BIG";
    return null;
}

// ============================================================
//  PREDICTION LOGIC
// ============================================================

function decidePrediction(list) {
    if (!list || list.length < 4) return null;

    const fullHistory = buildBSFromList(list, 10);
    if (fullHistory.length < 2) return null;

    const mode = getModeFromLast2(fullHistory);
    if (!mode) return null;

    const prediction = getPredictionFromMode(fullHistory, mode);
    if (!prediction) return null;

    return {
        type: 'SIZE',
        val: prediction,
        mode: mode,
        history: fullHistory.slice(-4).join('')
    };
}


// ════════════════════════════════════════════════════════════════════
//  AUTO-LEVEL CORRECTION: ENTER SKIP MODE AFTER 3 CONSECUTIVE LOSSES
// ════════════════════════════════════════════════════════════════════
/**
 * Triggers the auto-level correction flow when 3 consecutive losses occur.
 * 1. Skip next 4 periods (no bets, no predictions)
 * 2. After skip, analyze next 4 periods' actual results
 * 3. If analysis shows the same pattern as before → resume prediction
 * 4. If pattern changed → reset to L1 with fresh analysis
 */
function triggerAutoLevelCorrection(userId, chatId) {
    const state = userStates[userId];
    const st = autobetState[userId];
    const sa = skipAnalysisState[userId];

    // Don't retrigger if already in skip/analysis mode
    if (sa.mode === "SKIP" || sa.mode === "ANALYSIS") {
        console.log(`[USER ${userId}] Already in skip/analysis mode, ignoring retrigger.`);
        return;
    }

    // Save current state snapshot
    sa.originalMode = state.currentMode || getModeFromLast2(state.resultHistory);
    sa.originalHistory = [...state.resultHistory.slice(-6)]; // keep last 6 results as context

    // Enter SKIP mode for 4 periods
    sa.mode = "SKIP";
    sa.skipRemaining = 4;
    sa.analysisBuffer = [];
    sa.analysisCount = 0;
    sa.patternMatched = false;

    console.log(`[USER ${userId}] 🔴 3 CONSECUTIVE LOSSES! Entering SKIP mode for 4 periods.`);

    if (chatId && bot) {
        bot.sendMessage(chatId,
            "╔══════════════════════════╗\n" +
            "║  🚨 AUTO-LEVEL CORRECT   ║\n" +
            "╠══════════════════════════╣\n" +
            "║ 3 Losses detected!       ║\n" +
            "║ Skipping 4 periods...     ║\n" +
            "║ After skip: Analyzing     ║\n" +
            "║ next 4 periods pattern    ║\n" +
            "║ before resuming bets      ║\n" +
            "╚══════════════════════════╝"
        );
    }
}

/**
 * Process skip mode — count down skip periods
 * Collects actual results during the analysis phase
 */
function processSkipAnalysis(userId, actualResult) {
    const sa = skipAnalysisState[userId];
    const state = userStates[userId];
    const chatId = userId; // for logBoth (userId can be used as chatId in some cases)

    // Add result to analysis buffer (we observe but don't bet)
    sa.analysisBuffer.push(actualResult);

    if (sa.mode === "SKIP") {
        sa.skipRemaining--;
        console.log(`[USER ${userId}] SKIP: ${sa.skipRemaining} remaining`);

        if (sa.skipRemaining <= 0) {
            // Skip done → Enter ANALYSIS mode
            sa.mode = "ANALYSIS";
            sa.analysisCount = 0;
            sa.analysisBuffer = []; // Clear buffer, start fresh analysis
            console.log(`[USER ${userId}] SKIP complete. Entering ANALYSIS phase...`);
        }
    } else if (sa.mode === "ANALYSIS") {
        sa.analysisCount++;
        console.log(`[USER ${userId}] ANALYSIS: Period ${sa.analysisCount}/4 — Result: ${actualResult}`);

        if (sa.analysisCount >= 4) {
            // Analysis complete — compare pattern
            analyzePatternAndResume(userId, chatId);
        }
    }
}

/**
 * After analyzing 4 periods, check if the pattern matches the original mode.
 * If yes → resume prediction at L1.
 * If no → reset everything and start fresh.
 */
function analyzePatternAndResume(userId, chatId) {
    const sa = skipAnalysisState[userId];
    const state = userStates[userId];
    const st = autobetState[userId];

    const analysisResults = sa.analysisBuffer; // 4 results like ['B','S','B','B']
    
    console.log(`[USER ${userId}] 📊 Analysis Results: ${analysisResults.join(' ')}`);
    console.log(`[USER ${userId}] Original Mode was: ${sa.originalMode}`);

    // Determine new mode from analysis results
    const newMode = getModeFromLast2(analysisResults);
    console.log(`[USER ${userId}] New detected mode: ${newMode}`);

    // Check if the pattern is consistent (at least 3 out of 4 follow the mode)
    let patternConsistent = false;
    if (newMode) {
        let matchCount = 0;
        for (let i = 1; i < analysisResults.length; i++) {
            if (newMode === "SAME" && analysisResults[i] === analysisResults[i - 1]) matchCount++;
            if (newMode === "OPPOSITE" && analysisResults[i] !== analysisResults[i - 1]) matchCount++;
        }
        // At least 2 out of 3 comparisons should match (i.e., pattern is stable)
        if (matchCount >= 2) {
            patternConsistent = true;
        }
    }

    // Also check against original mode
    const sameAsOriginal = (newMode === sa.originalMode);

    if (patternConsistent && sameAsOriginal) {
        // Pattern matched! Resume prediction
        sa.patternMatched = true;
        console.log(`[USER ${userId}] ✅ Pattern MATCHED! Resuming prediction at L1.`);

        // Reset state for fresh start
        st.level = 1;
        st.consecutiveLoss = 0;
        st.inMart = false;
        state.skipCount = 0;
        state.currentMode = newMode;

        // Keep the analysis results as part of history
        for (const r of analysisResults) {
            state.resultHistory.push(r);
        }
        if (state.resultHistory.length > 20) {
            state.resultHistory = state.resultHistory.slice(-20);
        }

        if (chatId && bot) {
            bot.sendMessage(chatId,
                "╔══════════════════════════╗\n" +
                "║  ✅ PATTERN MATCHED!      ║\n" +
                "╠══════════════════════════╣\n" +
                "║ Mode: " + newMode + " (same as before)\n" +
                "║ Analysis: " + analysisResults.join('') + "\n" +
                "║ Consistent: " + patternConsistent + "\n" +
                "║ Resuming at L1...\n" +
                "╚══════════════════════════╝"
            );
        }
    } else {
        // Pattern didn't match — reset completely
        console.log(`[USER ${userId}] ❌ Pattern MISMATCH! Resetting. New mode: ${newMode}, Original: ${sa.originalMode}, Consistent: ${patternConsistent}`);

        st.level = 1;
        st.consecutiveLoss = 0;
        st.inMart = false;
        state.skipCount = 0;
        state.currentMode = newMode || null;

        // Replace history with analysis results
        state.resultHistory = [...analysisResults];

        if (chatId && bot) {
            bot.sendMessage(chatId,
                "╔══════════════════════════╗\n" +
                "║  ⚠️ PATTERN CHANGED      ║\n" +
                "╠══════════════════════════╣\n" +
                "║ Old Mode: " + (sa.originalMode || "N/A") + "\n" +
                "║ New Mode: " + (newMode || "N/A") + "\n" +
                "║ Analysis: " + analysisResults.join('') + "\n" +
                "║ Resetting to L1...\n" +
                "║ New pattern detected\n" +
                "╚══════════════════════════╝"
            );
        }
    }

    // Clear skip analysis state
    sa.mode = null;
    sa.skipRemaining = 0;
    sa.analysisBuffer = [];
    sa.analysisCount = 0;
    sa.patternMatched = false;
}

// 1. updateAfterResult - Corrected Level Management WITH AUTO-LEVEL CORRECTION
function updateAfterResult(userId, wasWin, actualSize, betPlaced) {
    initState(userId);
    const state = userStates[userId];
    const st = autobetState[userId];
    const cfg = autobetCfg[userId];
    const sa = skipAnalysisState[userId];

    const bs = (actualSize === "BIG" || actualSize === "B") ? "B" : "S";

    // If we're in SKIP or ANALYSIS mode, just observe (don't update game state)
    if (sa.mode === "SKIP" || sa.mode === "ANALYSIS") {
        processSkipAnalysis(userId, bs);
        return; // Don't update levels, don't count as win/loss
    }

    state.resultHistory.push(bs);
    if (state.resultHistory.length > 20) state.resultHistory.shift();

    if (wasWin) {
        // Reset everything on win
        st.consecutiveLoss = 0;
        st.level = 1;
        st.inMart = false;
        // Exit skip mode if any
        if (sa.mode) {
            sa.mode = null;
            sa.skipRemaining = 0;
            sa.analysisBuffer = [];
            sa.analysisCount = 0;
        }
    } else {
        st.consecutiveLoss++;
        
        // CRITICAL FIX: If a bet was placed, we must be in Martingale mode
        if (betPlaced) {
            st.inMart = true;
        }

        if (st.inMart) {
            // Already betting? Increment level
            st.level++;
            
            // Check for Max Level
            if (st.level > cfg.maxLvl) {
                st.level = 1;
                st.consecutiveLoss = 0;
                st.inMart = false;
                // Don't trigger auto-correction on max level overflow
                return;
            }

            // --- AUTO-LEVEL CORRECTION: 3 CONSECUTIVE LOSSES ---
            if (st.consecutiveLoss >= 3) {
                triggerAutoLevelCorrection(userId, null);
                return; // Exit — next 4 periods will be skipped
            }

            // --- L4 ENTRY CHECK (Safety) ---
            if (st.level === 4) {
                const last4 = state.resultHistory.slice(-4).join('');
                const dangerousPatterns = ['SSBB', 'BBSS', 'SSSB', 'BBBS', 'SBBS', 'BSSB'];
                if (dangerousPatterns.includes(last4)) {
                    state.skipCount = 4;
                    console.log(`[USER ${userId}] Dangerous Pattern ${last4} at L4 Entry -> Skipping 4.`);
                }
            }
        } else {
            // WATCH PHASE: Check if trigger hit
            if (!cfg.watch || st.consecutiveLoss >= cfg.watchLoss) {
                st.inMart = true;
                st.level = 1; // Start L1 for the NEXT period
            }
        }
    }
}


function getStatus(userId) {
    initState(userId);
    const state = userStates[userId];
    const st = autobetState[userId];
    const sa = skipAnalysisState[userId];
    let skipInfo = "";
    
    // Show skip/analysis mode info
    if (sa.mode === "SKIP") {
        skipInfo = ` | 🔴 SKIP: ${sa.skipRemaining} remaining`;
    } else if (sa.mode === "ANALYSIS") {
        skipInfo = ` | 🔵 ANALYSIS: ${sa.analysisCount}/4`;
    } else if (state.skipCount > 0) {
        skipInfo = ` | Skip: ${state.skipCount} remaining`;
    }
    
    return `${state.currentMode || 'SAME'} MODE | L${st ? st.level : 1}${skipInfo} | History: ${state.resultHistory.join('')}`;
}

// 2. handleWin - UI & Stats
async function handleWin(userId, chatId, actual, num) {
    const st=autobetState[userId],pt=profitTrack[userId],cfg=autobetCfg[userId];
    const amt=cfg.customBets[st.level-1] || (cfg.baseBet*MULT[st.level-1]),profit=amt*0.98;
    pt.totalBets++;pt.wins++;pt.pnl+=profit; pt.totalBetAmount = (pt.totalBetAmount || 0) + amt;
    pt.winStreak++;pt.lossStreak=0;if(pt.winStreak>pt.maxW)pt.maxW=pt.winStreak;
    st.level=1;st.inMart=false;st.consecutiveLoss=0;
    // Clear any skip analysis state on win
    const sa = skipAnalysisState[userId];
    if (sa) { sa.mode = null; sa.skipRemaining = 0; sa.analysisBuffer = []; sa.analysisCount = 0; }
    
    await send(chatId,
"╔══════════════════════════╗\n"+
"║  ✅ WIN! 🎉              ║\n"+
"╠══════════════════════════╣\n"+
"║ Number : "+num+"\n"+
"║ Result : "+actual+"\n"+
"║ Profit : +₹"+profit.toFixed(2)+"\n"+
"║ P&L    : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(2)+"\n"+
"║ Streak : "+pt.winStreak+" wins\n"+
"║ Total  : "+pt.wins+"W/"+pt.losses+"L\n"+
"║ Reset  : L1 | Watch 0/"+cfg.watchLoss+"\n"+
"╚══════════════════════════╝"
    );
    await sendSticker(chatId,WIN_STICKER);
}

async function handleLoss(userId, chatId, actual, num) {
    const st=autobetState[userId],pt=profitTrack[userId],cfg=autobetCfg[userId];
    const amt=cfg.customBets[st.level-1] || (cfg.baseBet*MULT[st.level-1]);
    pt.totalBets++;pt.losses++;pt.pnl-=amt; pt.totalBetAmount = (pt.totalBetAmount || 0) + amt;
    pt.lossStreak++;pt.winStreak=0;if(pt.lossStreak>pt.maxL)pt.maxL=pt.lossStreak;
    if(st.level<cfg.maxLvl){
        st.level++;st.inMart=true;
        const next=cfg.customBets[st.level-1] || (cfg.baseBet*MULT[st.level-1]);
        await send(chatId,
"╔══════════════════════════╗\n"+
"║  ❌ LOSS                 ║\n"+
"╠══════════════════════════╣\n"+
"║ Number : "+num+"\n"+
"║ Result : "+actual+"\n"+
"║ Loss   : -₹"+amt+"\n"+
"║ P&L    : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(2)+"\n"+
"╠══════════════════════════╣\n"+
"║ Next L"+st.level+" : ₹"+next+"\n"+
"╚══════════════════════════╝"
        );
        await sendSticker(chatId,LOSS_STICKER);
    } else {
        st.level=1;st.inMart=false;st.consecutiveLoss=0;
        await send(chatId,
"╔══════════════════════════╗\n"+
"║  💀 MAX LEVEL LOSS       ║\n"+
"╠══════════════════════════╣\n"+
"║ Loss   : -₹"+amt+"\n"+
"║ P&L    : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(2)+"\n"+
"║ Reset  : L1 | Watch 0/"+cfg.watchLoss+"\n"+
"╚══════════════════════════╝"
        );
        await sendSticker(chatId,LOSS_STICKER);
    }
}

// ============================================================
//  PREDICT LOOP
// ============================================================
function parseItem(item) {
    const n = +(item.number || item.winNumber || 0);
    return {
        n,
        size: n >= 5 ? "BIG" : "SMALL",
        color:
            n === 0 ? "RED" :
            n === 5 ? "GREEN" :
            n % 2 === 0 ? "RED" : "GREEN"
    };
}
function stk(arr, key) {
    let count = 1;
    let val = arr[0]?.[key];
    for (let i = 1; i < arr.length; i++) {
        if (arr[i][key] === val) count++;
        else break;
    }
    return { val, count };
}
async function runPredict(userId, chatId) {
    if(!running[userId])return;

    // --- WAITING CHECK ---
    const st = autobetState[userId];
    if (st.isWaiting) {
        if (Date.now() >= st.nextStartTime) {
            st.isWaiting = false;
            st.nextStartTime = null;
            profitTrack[userId].pnl = 0;
            // Also clear skip analysis state on restart
            if (skipAnalysisState[userId]) {
                skipAnalysisState[userId] = {
                    mode: null, skipRemaining: 0, analysisBuffer: [],
                    originalMode: null, originalHistory: [], patternMatched: false, analysisCount: 0
                };
            }
            await send(chatId, "🔄 Timed Restart! Starting new section now...");
        } else {
            return setTimeout(()=>runPredict(userId,chatId), 60000);
        }
    }

    const list = await fetchList();
    if(!list){
        await logBoth(chatId, "⚠️ API error — retrying in 15s...");
        return setTimeout(()=>runPredict(userId,chatId), 15000);
    }

    // --- SKIP/ANALYSIS MODE: Observe only, don't predict or bet ---
    const sa = skipAnalysisState[userId];
    if (sa && (sa.mode === "SKIP" || sa.mode === "ANALYSIS")) {
        const next = (BigInt(list[0].issueNumber)+1n).toString();
        const period = list[0]; // current period (just finished)
        const num = parseInt(period.number || period.winNumber || 0);
        const actualSize = num >= 5 ? "BIG" : "SMALL";
        
        // Update result history for observation
        const state = userStates[userId];
        const bs = num >= 5 ? "B" : "S";
        state.resultHistory.push(bs);
        if (state.resultHistory.length > 20) state.resultHistory.shift();

        const skLabel = sa.mode === "SKIP" ? "SKIP" : "ANALYSIS";
        const skCount = sa.mode === "SKIP" ? sa.skipRemaining : sa.analysisCount;
        
        if(!sentPeriods[userId].has(next)) {
            sentPeriods[userId].add(next);
            await send(chatId,
                "╔══════════════════════════╗\n" +
                "║   🔍 " + skLabel + " MODE             ║\n" +
                "╠══════════════════════════╣\n" +
                "║ Period : " + next.slice(-6) + "\n" +
                "║ Result : " + (num >= 5 ? "🔵 BIG" : "🟠 SMALL") + " (" + num + ")\n" +
                "║ Status : " + skLabel + " " + skCount + "/4\n" +
                "║ No Bet Placed           ║\n" +
                "╚══════════════════════════╝"
            );
        }
        return setTimeout(()=>runPredict(userId,chatId), 20000);
    }

    const next   = (BigInt(list[0].issueNumber)+1n).toString();
    const signal = decidePrediction(list);
    const data10=list.slice(0,10).map(parseItem);
    const szS=stk(data10,"size"),clS=stk(data10,"color");
    const dragonInfo=szS.count>=6?"🐉 SIZE:"+szS.val+" x"+szS.count:clS.count>=6?"🐉 COLOR:"+clS.val+" x"+clS.count:"";

    // Update currentMode based on detection
    if (signal && signal.mode) {
        userStates[userId].currentMode = signal.mode;
    }

    if(!signal){
        const sk="SK_"+next;
        if(!sentPeriods[userId].has(sk)){
            sentPeriods[userId].add(sk);
            await send(chatId,
"╔══════════════════════════╗\n"+
"║   ⏭️ SKIP                ║\n"+
"╠══════════════════════════╣\n"+
"║ Period : "+next.slice(-6)+"\n"+
(dragonInfo?"║ "+dragonInfo+"\n":"")+
"║ No 90%+ pattern\n"+
"║ Waiting next signal...\n"+
"╚══════════════════════════╝"
            );
        }
        return setTimeout(()=>runPredict(userId,chatId), 20000);
    }

    if(sentPeriods[userId].has(next)) return setTimeout(()=>runPredict(userId,chatId), 5000);
    sentPeriods[userId].add(next);
    if(sentPeriods[userId].size>50) sentPeriods[userId]=new Set([...sentPeriods[userId]].slice(-50));

    const cfg=autobetCfg[userId];
    const confBar="🟦".repeat(Math.round(signal.conf/10))+"⬜".repeat(10-Math.round(signal.conf/10));
    const predDisplay=signal.type==="SIZE"?(signal.val==="BIG"?"🔵 BIG":"🟠 SMALL"):(signal.val==="RED"?"🔴 RED":"🟢 GREEN");

    let abLine="🤖 AutoBet: OFF";
    if(cfg.enabled){
        const curBet = cfg.customBets[st.level-1] || (cfg.baseBet*MULT[st.level-1]);
        if(st.inMart) abLine="📈 MART L"+st.level+": ₹"+curBet;
        else if(cfg.watch&&st.consecutiveLoss<cfg.watchLoss) abLine="👀 Watch: "+st.consecutiveLoss+"/"+cfg.watchLoss;
        else abLine="💰 BET: ₹"+curBet+" L"+st.level;
    }

    await send(chatId,
"╔══════════════════════════╗\n"+
"║   👑 EARN WITH ME AI    ║\n"+
"╠══════════════════════════╣\n"+
"║ Period  : "+next.slice(-6)+"\n"+
"║ Signal  : "+predDisplay+"\n"+
"║ Pattern : "+signal.pat+"\n"+
"║ Conf    : "+signal.conf+"%\n"+
"║ "+confBar+"\n"+
"╠══════════════════════════╣\n"+
"║ "+abLine+"\n"+
"╠══════════════════════════╣\n"+
"║ BET ON  : "+signal.val+"\n"+
"╚══════════════════════════╝",
        {reply_markup:{inline_keyboard:[[{text:"💰 CHECK NOW",url:REG_LINK}]]}}
    );

    if (cfg.enabled ) { 
        const result = await placeBet(userId, chatId, next, signal.val, signal.type, st.level);
        if (result && result.ok) {
            await send(chatId, "✅ Bet Success! " + result.bc + " ₹" + result.amt + " L" + st.level + "\n⏳ Checking result...");
        }
    }

    checkResult(userId, chatId, next, signal.val, signal.type);
}

// ============================================================
//  RESULT CHECKER
// ============================================================


// 4. checkResult - Robust Update & Full UI
async function checkResult(userId, chatId, target, predicted, predType) {
    let tries=0;
    const cfg=autobetCfg[userId],st=autobetState[userId],pt=profitTrack[userId];
    const wasReal=cfg.enabled ;
    
    const iv=setInterval(async()=>{
        if(!running[userId])return clearInterval(iv);
        if(++tries>20){
            clearInterval(iv);
            await logBoth(chatId, "⏱ Timeout — next...");
            setTimeout(()=>{if(running[userId])runPredict(userId,chatId);},3000);
            return;
        }
        const list=await fetchList();if(!list)return;
        if(BigInt(list[0].issueNumber)<BigInt(target))return;
        clearInterval(iv);

        const res=list.find(i=>i.issueNumber===target)||list[0];
        const num=parseInt(res.number||res.winNumber||0);
        let actual;
        if(predType==="SIZE")actual=num>=5?"BIG":"SMALL";
        else actual=num===0?"RED":num===5?"GREEN":num%2===0?"RED":"GREEN";
        const win = predicted === actual;

        // Pass betPlaced flag: true only if AutoBet was enabled and bet was placed
        updateAfterResult(userId, win, actual, wasReal);

        const s = stats[userId];
        s.total++;
        if(win){s.win++;s.winStreak++;s.lossStreak=0;if(s.winStreak>s.maxWinStreak)s.maxWinStreak=s.winStreak;}
        else{s.loss++;s.lossStreak++;s.winStreak=0;if(s.lossStreak>s.maxLossStreak)s.maxLossStreak=s.lossStreak;}

        if(cfg.enabled && wasReal){
            if(win) await handleWin(userId,chatId,actual,num);
            else    await handleLoss(userId,chatId,actual,num);

            // --- PROFIT STOP & RESTART LOGIC ---
            if (pt.pnl >= cfg.targetProfit) {
                st.isWaiting = true;
                st.nextStartTime = Date.now() + (cfg.restartDelay * 60 * 1000); // Minutes calculation

                const restartTimeStr = new Date(st.nextStartTime).toLocaleTimeString();
                await send(chatId, 
                    "🎯 TARGET REACHED!\n" +
                    "Profit: ₹" + pt.pnl.toFixed(2) + "\n\n" +
                    "🛑 Bot Paused.\n" +
                    "⏳ Delay: " + cfg.restartDelay + " minutes\n" +
                    "🔄 Next Section: " + restartTimeStr
                );
            }

        } else if (cfg.enabled && !wasReal) {
            if(win) await send(chatId,"👀 Watch ✅ Correct! (No bet placed)");
            else    await send(chatId,"👀 Watch ❌ Incorrect! (No bet placed)");
        } else {
            if(win){
                await send(chatId,"✅ WIN! #"+num+" "+actual+"\n🔥 "+s.winStreak+" streak");
                await sendSticker(chatId,WIN_STICKER);
            } else {
                await send(chatId,"❌ LOSS #"+num+" "+actual+"\n💔 "+s.lossStreak+" loss");
                await sendSticker(chatId,LOSS_STICKER);
            }
        }
        setTimeout(()=>{if(running[userId])runPredict(userId,chatId);},8000);
    },10000);
}

// ============================================================
//  STATS
// ============================================================
function showStats(chatId,userId){
    const d=stats[userId],rate=d.total?((d.win/d.total)*100).toFixed(1):"0.0";
    const bar="🟦".repeat(d.total?Math.round(d.win/d.total*10):0)+"⬜".repeat(d.total?10-Math.round(d.win/d.total*10):10);
    send(chatId,"📊 STATS\n\nTotal: "+d.total+"\nWins: "+d.win+"\nLosses: "+d.loss+"\nAcc: "+rate+"%\n"+bar+"\n\nBest Win: "+d.maxWinStreak+" streak\nWorst Loss: "+d.maxLossStreak+" streak");
}
function profitReport(chatId,userId){
    const pt=profitTrack[userId],cfg=autobetCfg[userId];
    const rate=pt.totalBets?((pt.wins/pt.totalBets)*100).toFixed(1):"0.0";
    const amounts=cfg.customBets.slice(0,cfg.maxLvl);
    send(chatId,
"💰 PROFIT REPORT\n\n"+
"Bets  : "+pt.totalBets+"\nWins  : "+pt.wins+"\nLoss  : "+pt.losses+"\nRate  : "+rate+"%\n"+
"P&L   : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(2)+"\n"+
"Best W: "+pt.maxW+" | Worst L: "+pt.maxL+"\n\n"+
"Mart: ₹"+amounts.join("→₹")
    );
}
async function autobetStatus(chatId, userId) {
    const cfg = autobetCfg[userId], st = autobetState[userId], pt = profitTrack[userId];
    const amounts = cfg.customBets.slice(0, cfg.maxLvl);
    const creds = userCreds[userId] || {};
    const sa = skipAnalysisState[userId];
    
    let liveBal = "❌ Login Required";
    let token = getToken(userId);
    if (token && token.length > 20) {
        try {
            const r = await axios.get("https://api.bdg88zf.com/api/webapi/GetBalance", {
                headers: {
                    "Authorization": "Bearer " + token,
                    "Ar-Origin": "https://bdgwin901.com",
                    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36"
                },
                timeout: 5000
            });
            if (r.data && r.data.code === 0) {
                liveBal = "₹" + r.data.data.balance;
            } else {
                liveBal = "⚠️ Token Expired";
            }
        } catch (e) {
            liveBal = "⚠️ API Error";
        }
    }

    let waitLine = "";
    if (st.isWaiting) {
        const diff = Math.round((st.nextStartTime - Date.now()) / 60000);
        waitLine = "\n⏳ Waiting: " + diff + " mins to restart";
    }

    let skipLine = "";
    if (sa && sa.mode === "SKIP") {
        skipLine = "\n🔴 Auto-Correct: SKIP (" + sa.skipRemaining + " periods left)";
    } else if (sa && sa.mode === "ANALYSIS") {
        skipLine = "\n🔵 Auto-Correct: ANALYSIS (" + sa.analysisCount + "/4 done)";
    }

    send(chatId,
"🤖 AUTOBET STATUS\n\n"+
"💰 Live Balance: "+liveBal+"\n"+
"Enabled  : "+(cfg.enabled?"✅ ON":"❌ OFF")+"\n"+
"Token    : "+(token.length>20?"✅":"❌")+"\n"+
"AutoLogin: "+(creds.phone?"✅ "+creds.phone.slice(0,6)+"***":"❌")+"\n"+
"Watch    : "+(cfg.watch?"ON":"OFF")+"\n"+
"WatchLoss: "+st.consecutiveLoss+"/"+cfg.watchLoss+"\n"+
"Base Bet : ₹"+cfg.baseBet+"\n"+
"Max Level: "+cfg.maxLvl+"\n"+
"Target Profit: ₹"+cfg.targetProfit+"\n"+
"Section Delay: "+cfg.restartDelay+" minutes"+
waitLine+skipLine+"\n"+
"In Mart  : "+(st.inMart?"YES":"NO")+"\n"+
"P&L      : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(2)+"\n\n"+
"Mart: ₹"+amounts.join("→₹")
    );
}


// ============================================================
//  KEYBOARDS
// ============================================================
function userMenu(id){
    const rows=[["▶️ Start Prediction","🛑 Stop"],["📊 Stats","💰 Profit","📩 Contact"],["🤖 AutoBet Setup","🔑 My Token"]];
    if(isAdmin(id))rows.push(["👑 Admin Panel"]);
    return{keyboard:rows,resize_keyboard:true};
}
const ownerMenu={keyboard:[["👥 All Users","👮 All Admins"],["👤 Add Admin","🗑 Remove Admin"],["🔑 Generate Key","📋 All Keys"],["🟢 Add User","🔴 Remove User"],["🔐 Set Token","📊 All Status"],["🚪 Owner Logout"]],resize_keyboard:true};
const adminMenu={keyboard:[["👥 Active Users","🔑 Generate Key"],["🟢 Add User","🔴 Remove User"],["📋 All Keys","🚪 Admin Logout"]],resize_keyboard:true};
const autobetMenu={keyboard:[
    ["✅ Enable AutoBet","❌ Disable AutoBet"],
    ["👀 Watch Mode ON","👀 Watch Mode OFF"],
    ["💰 Set Base Bet","📈 Set Max Level"],
    ["🎯 Set Profit Target", "⏳ Set Section Delay"],
    ["🔢 Set Watch Losses","📊 AutoBet Status"],
    ["📝 Set Custom Bets","🔙 Back"]
],resize_keyboard:true};

// ============================================================
//  BOT INIT
// ============================================================
let bot;
function startBot(){
    if(bot){try{bot.stopPolling();}catch(e){}}
    bot=new TelegramBot(BOT_TOKEN,{polling:{interval:1000,autoStart:true,params:{timeout:30}}});
    bot.on("polling_error",err=>{console.error("Poll:",err.message);});
    bot.on("error",err=>{console.error("Bot:",err.message);});
    addHandlers();
    console.log("✅ SIVA BOT running...");
    startAutoLoginTask();
}

async function send(chatId,text,opts={}){
    try{return await bot.sendMessage(chatId,text,opts);}
    catch(e){if(e.message&&e.message.includes("parse entities")){try{const o={...opts};delete o.parse_mode;return await bot.sendMessage(chatId,text,o);}catch(e2){}}console.error("send:",e.message?.substr(0,60));}
}
async function sendSticker(chatId,sid){try{await bot.sendSticker(chatId,sid);}catch(e){}}

// ============================================================
//  AUTO LOGIN TASK
// ============================================================
function startAutoLoginTask() {
    console.log("🕒 [TASK] Auto-login scheduler started (7 mins)");
    setInterval(async () => {
        const userIds = Object.keys(userCreds);
        for (const userId of userIds) {
            const creds = userCreds[userId];
            if (creds && creds.phone && creds.pass) {
                await logBoth(userId, `🕒 [TASK] Attempting periodic login for user: ${userId}`);
                await robustLogin(userId, userId, false); 
            }
        }
    }, 7 * 60 * 1000); 
}

// ============================================================
//  HANDLERS
// ============================================================
function addHandlers(){
    bot.onText(/\/start/,(msg)=>{
        const id=msg.from.id;initUser(id);
        const status=hasAccess(id)?"✅ ACTIVE — "+daysLeft(id)+"d left":"❌ NO ACCESS";
        send(msg.chat.id,
"╔══════════════════════════╗\n║  👑EARN WITH ME BOT    ║\n╠══════════════════════════╣\n"+
"║ Status : "+status+"\n║ ID     : "+id+"\n║ Admin  : "+ADMIN_HANDLE+"\n╠══════════════════════════╣\n"+
"║ /key CODE to activate    ║\n╚══════════════════════════╝",
        {reply_markup:userMenu(id)});
    });

    bot.onText(/\/key (.+)/,(msg,match)=>{
        const id=msg.from.id;initUser(id);
        const res=activateKey(id,match[1].trim());
        if(res.ok){send(msg.chat.id,"🎊 KEY ACTIVATED!\n⏳ "+res.days+" days\n📅 "+res.expiry,{reply_markup:userMenu(id)});send(OWNER_ID,"🔔 Key used!\nUser: "+id+"\nDays: "+res.days);}
        else send(msg.chat.id,res.msg);
    });

    bot.onText(/\/adminlogin (.+)/,(msg,match)=>{
        const id=msg.from.id;
        if(adminPasswords[id]&&match[1].trim()===adminPasswords[id]){
            adminLoggedIn[id]=true;
            send(id,"👑 Admin Mode ON",{reply_markup:adminMenu});
        } else send(id,"❌ Wrong password");
    });

    bot.onText(/\/addadmin (.+)/,(msg,match)=>{
        if(!isAdminIn(msg.from.id))return send(msg.from.id,"Admin only!");
        const tid=parseInt(match[1].trim());
        if(isNaN(tid))return send(msg.from.id,"❌ Invalid ID");
        adminPasswords[tid]=match[2]||tid.toString();
        send(msg.from.id,"✅ "+tid+" added as admin");
    });

    bot.onText(/\/setcreds (.+)/,(msg,match)=>{
        const id=msg.from.id;
        const parts=match[1].trim().split(/\s+/);
        if(parts.length<2)return send(id,"❌ /setcreds PHONE PASSWORD");
        userCreds[id]={phone:parts[0],pass:parts.slice(1).join(" ")};
        send(id,"✅ Creds saved! Phone: "+parts[0].slice(0,6)+"***");
    });

    bot.onText(/\/setmytoken (.+)/,(msg,match)=>{
        const id=msg.from.id;
        userTokens[id]=match[1].trim();
        send(id,"✅ Token saved!");
    });

    bot.onText(/\/login/,(msg)=>{
        const id=msg.from.id;
        send(id,"🔄 Testing login...");
        autoLogin(id,msg.chat.id,false);
    });

    const AB=["✅ Enable AutoBet","❌ Disable AutoBet","👀 Watch Mode ON","👀 Watch Mode OFF",
              "💰 Set Base Bet","📈 Set Max Level","🎯 Set Profit Target","⏳ Set Section Delay",
              "🔢 Set Watch Losses","📊 AutoBet Status","📝 Set Custom Bets","🔙 Back",
              "▶️ Start Prediction","🛑 Stop","📊 Stats","💰 Profit","📩 Contact","👑 Admin Panel",
              "🤖 AutoBet Setup","🔑 My Token"];

    bot.on("message",async(msg)=>{
        const text=msg.text;
        const id=msg.from.id;
        if(!text)return;
        initUser(id);

        // Owner login
        if(id===OWNER_ID&&!ownerLoggedIn&&text.includes(OWNER_PASS)){
            ownerLoggedIn=true;
            return send(id,"👑 Owner Mode ON",{reply_markup:ownerMenu});
        }

        // Admin state handling
        if(ownerState){
            if(text==="🔙 Back"){ownerState=null;return send(id,"Out.",{reply_markup:ownerMenu});}
            if(ownerState.action==="addadmin"){adminPasswords[parseInt(text)]=text;ownerState=null;return send(id,"✅ "+text+" admin added",{reply_markup:ownerMenu});}
            if(ownerState.action==="removeadmin"){delete adminPasswords[parseInt(text)];delete adminLoggedIn[parseInt(text)];ownerState=null;return send(id,"🚫 Removed",{reply_markup:ownerMenu});}
            if(ownerState.action==="genkey"){const d=parseInt(text);if(isNaN(d)||d<1)return send(id,"❌ Days?");const k=generateKey(d,id);ownerState=null;return send(id,"🔑 Key:\n\n"+k+"\n\n"+d+"d",{reply_markup:ownerMenu});}
            if(ownerState.action==="adduser"){if(!ownerState.step2){const t=parseInt(text);if(isNaN(t))return send(id,"❌");ownerState={action:"adduser",step2:true,tid:t};return send(id,"ID:"+t+"\nDays?");}else{const d=parseInt(text);if(isNaN(d)||d<1)return send(id,"❌");usersAccess[ownerState.tid]=Date.now()+d*86400000;ownerState=null;send(id,"✅ "+ownerState.tid+" "+d+"d",{reply_markup:ownerMenu});send(ownerState.tid,"🎊 ACCESS! "+d+"d");return;}}
            if(ownerState.action==="removeuser"){const t=parseInt(text);const was=hasAccess(t);delete usersAccess[t];running[t]=false;ownerState=null;return send(id,was?"🚫 Removed":"⚠️ Not active",{reply_markup:ownerMenu});}
            if(ownerState.action==="settoken"){GLOBAL_TOKEN=text.trim();ownerState=null;return send(id,"✅ Global token set!",{reply_markup:ownerMenu});}
        }

        if(id===OWNER_ID&&ownerLoggedIn){
            if(text==="👥 All Users")    return send(OWNER_ID,"👥\n\n"+activeUsersList());
            if(text==="👮 All Admins")   return send(OWNER_ID,"👮\n\n"+adminList());
            if(text==="👤 Add Admin")    {ownerState={action:"addadmin"};return send(OWNER_ID,"User ID:");}
            if(text==="🗑 Remove Admin") {ownerState={action:"removeadmin"};return send(OWNER_ID,"Admin ID:");}
            if(text==="🔑 Generate Key") {ownerState={action:"genkey"};return send(OWNER_ID,"Days?");}
            if(text==="📋 All Keys")     return send(OWNER_ID,"📋\n\n"+allKeysList());
            if(text==="🟢 Add User")     {ownerState={action:"adduser"};return send(OWNER_ID,"User ID:");}
            if(text==="🔴 Remove User")  {ownerState={action:"removeuser"};return send(OWNER_ID,"User ID?");}
            if(text==="🔐 Set Token")    {ownerState={action:"settoken"};return send(OWNER_ID,"Token paste:");}
            if(text==="📊 All Status")    {
                const ids = Object.keys(usersAccess);
                if(ids.length === 0) return send(OWNER_ID, "No users found.");
                let report = "📊 TEAM MEMBERS ALL STATUS 📊\n\n";
                ids.forEach(uid => {
                    initUser(uid);
                    const pt = profitTrack[uid];
                    const st = autobetState[uid];
                    const sa = skipAnalysisState[uid];
                    const pnlStr = (pt.pnl >= 0 ? "+" : "") + pt.pnl.toFixed(2);
                    let modeStr = "Normal";
                    if (sa && sa.mode === "SKIP") modeStr = "🔴 SKIP";
                    else if (sa && sa.mode === "ANALYSIS") modeStr = "🔵 ANALYSIS";
                    report += `👤 ID: ${uid}\n`;
                    report += `💰 Total Bet: ₹${(pt.totalBetAmount || 0).toFixed(2)}\n`;
                    report += `📈 Profit: ₹${pnlStr}\n`;
                    report += `🎮 Level: L${st.level}\n`;
                    report += `📊 Win/Loss: ${pt.wins}W / ${pt.losses}L\n`;
                    report += `🔄 Mode: ${modeStr}\n`;
                    report += `------------------------\n`;
                });
                return send(OWNER_ID, report);
            }
            if(text==="🚪 Owner Logout") {ownerLoggedIn=false;return send(OWNER_ID,"🔒 Out.",{reply_markup:userMenu(id)});}
        }

        if(isAdmin(id) && isAdminIn(id) && adminState[id]){
            const s = adminState[id];
            if(AB.includes(text)){ delete adminState[id]; }
            else if(s.action==="genkey"){const d=parseInt(text);if(isNaN(d)||d<1)return send(id,"❌ Days?");const k=generateKey(d,id);delete adminState[id];return send(id,"🔑 Key:\n\n"+k+"\n\n"+d+"d",{reply_markup:adminMenu});}
            else if(s.action==="adduser"){if(!s.step2){const t=parseInt(text);if(isNaN(t))return send(id,"❌");adminState[id]={action:"adduser",step2:true,tid:t};return send(id,"ID:"+t+"\nDays?");}else{const d=parseInt(text);if(isNaN(d)||d<1)return send(id,"❌");usersAccess[s.tid]=Date.now()+d*86400000;delete adminState[id];send(id,"✅ "+s.tid+" "+d+"d",{reply_markup:adminMenu});send(s.tid,"🎊 ACCESS! "+d+"d");return;}}
            else if(s.action==="removeuser"){const t=parseInt(text);if(isNaN(t))return;const was=hasAccess(t);delete usersAccess[t];running[t]=false;delete adminState[id];send(id,was?"🚫 Removed":"⚠️ Not active",{reply_markup:adminMenu});if(was)send(t,"🔴 Removed.");return;}
        }

        if(hasAccess(id) && userAction[id]){
            const s = userAction[id];
            if(text === "🔙 Back") { delete userAction[id]; }
            else if(s.action === "setbase"){
                const v = parseInt(text);
                if(isNaN(v) || v < 1) return send(id, "❌ Invalid Amount! Min ₹1.");
                autobetCfg[id].baseBet = v;
                delete userAction[id];
                const a = MULT.slice(0, autobetCfg[id].maxLvl).map(m => v * m);
                return send(id, "✅ Base Bet Updated: ₹" + v + "\nMartingale: ₹" + a.join("→₹"), {reply_markup: autobetMenu});
            }
            else if(s.action === "setlvl"){
                const v = parseInt(text);
                if(isNaN(v) || v < 1 || v > 10) return send(id, "❌ Invalid Level! Enter 1-10.");
                autobetCfg[id].maxLvl = v;
                delete userAction[id];
                const a = MULT.slice(0, v).map(m => autobetCfg[id].baseBet * m);
                return send(id, "✅ Max Level Updated: L" + v + "\nMartingale: ₹" + a.join("→₹"), {reply_markup: autobetMenu});
            }
            else if(s.action === "setwloss"){
                const v = parseInt(text);
                if(isNaN(v) || v < 0) return send(id, "❌ Invalid Number!");
                autobetCfg[id].watchLoss = v;
                delete userAction[id];
                return send(id, "✅ Watch Loss Updated: " + v + "\n(Bot will wait for " + v + " losses before betting)", {reply_markup: autobetMenu});
            }
            else if(s.action === "setcustom"){
                const vals = text.split(/[, ]+/).map(v => parseInt(v.trim())).filter(v => !isNaN(v) && v > 0);
                if(vals.length === 0) return send(id, "❌ Invalid Format! Use: 1,4,7,9");
                autobetCfg[id].customBets = vals;
                autobetCfg[id].maxLvl = vals.length;
                delete userAction[id];
                return send(id, "✅ Custom Bets Updated!\nLevels: " + vals.length + "\nSequence: ₹" + vals.join(" → ₹"), {reply_markup: autobetMenu});
            }
        }

        if(isAdmin(id)&&isAdminIn(id)){
            if(text==="👥 Active Users") return send(id,"👥\n\n"+activeUsersList());
            if(text==="🔑 Generate Key") {adminState[id]={action:"genkey"};return send(id,"Days?");}
            if(text==="🟢 Add User")     {adminState[id]={action:"adduser"};return send(id,"User ID?");}
            if(text==="🔴 Remove User")  {adminState[id]={action:"removeuser"};return send(id,"User ID?");}
            if(text==="📋 All Keys")     return send(id,"📋\n\n"+allKeysList());
            if(text==="🚪 Admin Logout") {adminLoggedIn[id]=false;return send(id,"🔒 Out.",{reply_markup:userMenu(id)});}
        }

        if(text==="👑 Admin Panel"&&isAdmin(id)){
            if(!isAdminIn(id))return send(id,"Login:\n/adminlogin YOUR_PASS");
            return send(id,"👑 Admin",{reply_markup:adminMenu});
        }

        if(text==="🤖 AutoBet Setup"){
            if(!hasAccess(id))return send(id,"❌ No access.");
            const cfg=autobetCfg[id],creds=userCreds[id]||{};
            const amounts=MULT.slice(0,cfg.maxLvl).map(m=>cfg.baseBet*m);
            return send(id,
"🤖 AUTOBET SETTINGS\n\n"+
"Status   : "+(cfg.enabled?"✅ ON":"❌ OFF")+"\n"+
"Token    : "+(getToken(id).length>20?"✅ SET":"❌ MISSING")+"\n"+
"AutoLogin: "+(creds.phone?"✅ "+creds.phone.slice(0,6)+"***":"❌ /setcreds")+"\n"+
"Watch    : "+(cfg.watch?"ON":"OFF")+"\n"+
"WatchLoss: "+cfg.watchLoss+" consecutive\n"+
"Base Bet : ₹"+cfg.baseBet+"\n"+
"Max Level: "+cfg.maxLvl+"\n\n"+
"Mart: ₹"+amounts.join("→₹")+"\n\n"+
"/setcreds 916381605525 PASSWORD\n"+
"/setmytoken TOKEN",
            {reply_markup:autobetMenu});
        }

        if(text==="✅ Enable AutoBet"){
            const creds=userCreds[id]||{};
            if(!getToken(id)&&!creds.phone)return send(id,"❌ /setcreds FULLPHONE PASSWORD\nor /setmytoken TOKEN");
            autobetCfg[id].enabled=true;
            if(!getToken(id)&&creds.phone){
                send(id,"🔄 Auto login...");
                const ok=await autoLogin(id,msg.chat.id,true);
                if(ok)send(id,"✅ AutoBet ON!\n₹"+autobetCfg[id].baseBet+" | Watch:"+(autobetCfg[id].watch?autobetCfg[id].watchLoss+"L":"OFF"),{reply_markup:userMenu(id)});
                else send(id,"⚠️ Login fail. /setcreds பண்ணு.",{reply_markup:autobetMenu});
            } else {
                send(id,"✅ AutoBet ON!\n₹"+autobetCfg[id].baseBet+" | Watch:"+(autobetCfg[id].watch?autobetCfg[id].watchLoss+"L":"OFF"),{reply_markup:userMenu(id)});
            }
            return;
        }
        if(text==="❌ Disable AutoBet"){autobetCfg[id].enabled=false;return send(id,"❌ AutoBet OFF",{reply_markup:userMenu(id)});}
        if(text==="👀 Watch Mode ON") {autobetCfg[id].watch=true;return send(id,"👀 Watch ON — "+autobetCfg[id].watchLoss+" losses → bet");}
        if(text==="👀 Watch Mode OFF"){autobetCfg[id].watch=false;return send(id,"👀 Watch OFF — Direct bet!");}
        if(text==="💰 Set Base Bet"){userAction[id]={action:"setbase"};return send(id,"Enter base bet amount (e.g. 1):");}
        if(text==="📈 Set Max Level"){userAction[id]={action:"setlvl"};return send(id,"Enter max level (1-10):");}
        if(text==="🎯 Set Profit Target"){userAction[id]={action:"settarget"};return send(id,"Enter target profit (Min ₹10):");}
        if(text==="⏳ Set Section Delay"){userAction[id]={action:"setdelay"};return send(id,"Enter restart delay in MINUTES (e.g. 30):");}
        if(text==="📝 Set Custom Bets"){userAction[id]={action:"setcustom"};return send(id,"📝 Enter Custom Bet Sequence (e.g. 1,4,7,9):");}
        if(text==="🔢 Set Watch Losses"){
            userAction[id]={action:"setwloss"};
            return send(id,"Enter watch loss count (e.g. 3):");
        }

        // --- INPUT SAVING LOGIC ---
        if(hasAccess(id) && userAction[id]){
            const s = userAction[id];
            if(text === "🔙 Back") { delete userAction[id]; }
            
            else if(s.action === "settarget"){
                const v = parseFloat(text);
                if(isNaN(v) || v < 10) return send(id, "❌ Min ₹10 kudunga!");
                autobetCfg[id].targetProfit = v;
                delete userAction[id];
                return send(id, "✅ Profit target set to ₹"+v, {reply_markup: autobetMenu});
            }
            else if(s.action === "setdelay"){
                const v = parseInt(text);
                if(isNaN(v) || v < 1) return send(id, "❌ Invalid minutes!");
                autobetCfg[id].restartDelay = v;
                delete userAction[id];
                return send(id, "✅ Section delay set to "+v+" minutes", {reply_markup: autobetMenu});
            }
            else if(s.action === "setcustom"){
                const vals = text.split(/[, ]+/).map(v => parseInt(v.trim())).filter(v => !isNaN(v) && v > 0);
                if(vals.length === 0) return send(id, "❌ Format error! Use: 1,4,7,9");
                autobetCfg[id].customBets = vals;
                autobetCfg[id].maxLvl = vals.length;
                delete userAction[id];
                return send(id, "✅ Custom Bets Updated!\nLevels: " + vals.length + "\nSequence: ₹" + vals.join(" → ₹"), {reply_markup: autobetMenu});
            }
        }

        if(text==="📊 AutoBet Status") return await autobetStatus(msg.chat.id,id);

        if(text==="🔙 Back")return await send(id,"Main Menu",{reply_markup:userMenu(id)});

        if(text==="🔑 My Token"){
            const tok=getToken(id),creds=userCreds[id]||{};
            return send(id,"Token: "+(tok.length>20?"✅ ..."+tok.slice(-12):"❌")+"\nLogin: "+(creds.phone?"✅ "+creds.phone.slice(0,6)+"***":"❌")+"\n\n/setcreds FULLPHONE PASSWORD\n/setmytoken TOKEN\n/login — Test");
        }

      if(text==="▶️ Start Prediction"){
            if(!hasAccess(id))return send(msg.chat.id,"❌ No access!\n📩 "+ADMIN_HANDLE+"\nID: "+id);
            if(running[id])return send(msg.chat.id,"⚠️ Already running!");
            if(!getToken(id)&&userCreds[id]?.phone){await send(msg.chat.id,"🔄 Auto login...");await autoLogin(id,msg.chat.id,true);}
            running[id]=true;sentPeriods[id]=new Set();
            autobetState[id]={level:1,consecutiveLoss:0,inMart:false};

            // Initialize skip analysis state
            skipAnalysisState[id] = {
                mode: null, skipRemaining: 0, analysisBuffer: [],
                originalMode: null, originalHistory: [], patternMatched: false, analysisCount: 0
            };

            // Load previous B/S history from API
            const prevList = await fetchList();
            initState(id);

            if (prevList && prevList.length >= 4) {
                userStates[id].resultHistory = buildBSFromList(prevList, 15);
                await send(msg.chat.id, "📋 Loaded history: " + (userStates[id].resultHistory || []).join(''));

                // ─── SSBB / BBSS PATTERN CHECK ───
                const hist = userStates[id].resultHistory;
                if (hist.length >= 4) {
                    const last4 = hist.slice(-4).join('');
                    if (last4 === 'SSBB' || last4 === 'BBSS' || last4 === 'SSSB' || last4 === 'BBBS' || last4 === 'SBBS' || last4 === 'BSSB') {
                        userStates[id].skipCount = 4;
                        await send(msg.chat.id, 
                            "⚠️ Pattern Detected: " + last4 + "\n" +
                            "🚫 Skipping next 4 periods...\n" +
                            "💡 Prediction will resume after skip."
                        );
                    }
                }
            }

            const cfg=autobetCfg[id];
            await send(msg.chat.id,
"🚀 ENGINE ON!\n\nAutoBet: "+(cfg.enabled?"✅ ON":"❌ OFF")+"\nWatch  : "+(cfg.watch?"ON ("+cfg.watchLoss+"L)":"OFF")+"\nBase   : ₹"+cfg.baseBet+" | MaxLvl: "+cfg.maxLvl+"\n\n🔴 Auto-Level Correct: ON (3 loss → skip 4 → analyze 4)"
            );
            runPredict(id,msg.chat.id);
        }
        if(text==="🛑 Stop")   {running[id]=false;send(msg.chat.id,"🛑 Stopped.");}
        if(text==="📊 Stats")  showStats(msg.chat.id,id);
        if(text==="💰 Profit") profitReport(msg.chat.id,id);
        if(text==="📩 Contact") send(msg.chat.id,"📩 "+ADMIN_HANDLE+"\nID: "+id);
    });
}
startBot();
