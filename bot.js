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
const REG_LINK     = "https://www.goaoko.com/#/register?invitationCode=457367799017";
const WIN_STICKER  = "CAACAgUAAxkBAAFHUGNp4JX1-ohP4uBEWpfNptaz-HmwVgAC4hgAAhboKVbObuGuTcMs2zsE";
const LOSS_STICKER = "CAACAgUAAxkBAAFHUGVp4JX-BE2TRkhIKTwcjkwW-gzdPAACthoAAoG8YVYiydObSa0O8zsE";

const BET_URL     = "https://api.ar-lottery01.com/api/Lottery/WinGoBet";
const LOGIN_URL   = "https://api.bdg88zf.com/api/webapi/Login";
const CAPTCHA_URL = "https://api.bdg88zf.com/api/webapi/GetCaptcha";
const DRAW_URL    = "https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json";

// Martingale multipliers — user can customize base bet
const MULT = [1, 3, 9, 27, 81, 243, 729, 2187, 6561, 19683]; // Standard 3x Martingale multipliers (can be customized)

// ============================================================
//  RENDER KEEP-ALIVE — Prevent render free tier sleep
// ============================================================
const http = require('http');
const PORT = process.env.PORT || 5000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('SIVA BOT OK');
}).listen(PORT, () => console.log(`✅ Keep-alive server on port ${PORT}`));

// Self-ping every 14 minutes to prevent sleep
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
let userAction   = {}; // To track user input for settings
let userCreds      = {};
let autobetCfg     = {};
let autobetState   = {};
let profitTrack    = {};
let GLOBAL_TOKEN   = "";
let userTokens     = {}; 
let userStates     = {};

// ============================================================
//  HELPERS
// ============================================================
async function fetchList() {
    // Placeholder for fetchList function
    // This should ideally fetch data from DRAW_URL
    try {
        const response = await axios.get(DRAW_URL, {
            headers: {
                "Accept": "application/json, text/plain, */*",
                "Origin": "https://bdgwin901.com",
                "Referer": "https://bdgwin901.com",
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

function initUser(id) {
    if (!stats[id])        stats[id]        = { total:0,win:0,loss:0,lossStreak:0,winStreak:0,maxWinStreak:0,maxLossStreak:0 };
    if (!userStates[id])   userStates[id]   = { history:[], mode:"NORMAL", recoveryCount:0 };
    if (!sentPeriods[id])  sentPeriods[id]  = new Set();
    if (!autobetCfg[id])   autobetCfg[id]   = { watch:false, watchLoss:5, baseBet:1, maxLvl:5, enabled:false, customBets:[1,3,9,27,81] };
    if (!autobetState[id]) autobetState[id] = { level:1, consecutiveLoss:0, inMart:false };
    if (!profitTrack[id])  profitTrack[id]  = { totalBets:0, wins:0, losses:0, pnl:0, winStreak:0, lossStreak:0, maxW:0, maxL:0, totalBetAmount: 0 };
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
    console.log("[LOGIN SIG INPUT]", str);
    const sig = crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0,32);
    console.log("[LOGIN SIG]", sig);
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

// autoLogin function (as provided previously, with chromePath adjusted for Windows if needed)
async function autoLogin(userId, chatId, silent = false) {
    if (loginLock[userId]) return false;
    loginLock[userId] = true;

    const creds = userCreds[userId] || {};
    const { phone, pass } = creds;

    if (!phone || !pass) {
        loginLock[userId] = false;
        return false;
    }

    const browser = await puppeteer.launch({
        headless: true, 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--disable-gpu']
    });

    try {
        const page = await browser.newPage();
        // Render RAM optimization
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

        // 1. லாகின் பக்கம் - load condition changed for speed
        await page.goto('https://bdgwin901.com/#/login', { waitUntil: 'domcontentloaded', timeout: 90000 });
        
        // Wait for inputs to appear
        await page.waitForSelector('input', { timeout: 30000 });
        const inputs = await page.$$('input');
        
        if (inputs.length < 2) throw new Error("Login inputs not found");

        await inputs[0].type(phone, { delay: 50 });
        await inputs[1].type(pass, { delay: 50 });
        
        // Click login button instead of Enter for better reliability
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const loginBtn = btns.find(b => b.innerText.includes('Log in') || b.innerText.includes('Login'));
            if (loginBtn) loginBtn.click();
            else document.querySelector('form')?.submit();
        });

        // 2. லாகின் முடிந்து ஹோம் பேஜ் வர வரை காத்திரு
        try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch (e) {
            console.log("Navigation timeout, but checking if we are logged in...");
        }
        await new Promise(r => setTimeout(r, 5000));

        // 3. பாப்-அப் இருந்தால் க்ளோஸ் செய்
        await page.evaluate(() => {
            const closeBtn = document.querySelector('.van-icon-cross') || document.querySelector('.close-icon');
            if (closeBtn) closeBtn.click();
        });
        await new Promise(r => setTimeout(r, 1000));

        // 4. Lottery பட்டனை கிளிக் செய்
        await page.evaluate(() => {
            const navItems = Array.from(document.querySelectorAll('div, span'));
            const lotteryBtn = navItems.find(el => el.innerText.trim() === 'Lottery');
            if (lotteryBtn) lotteryBtn.click();
        });
        await new Promise(r => setTimeout(r, 2000));

        // 5. Win Go பட்டனை கிளிக் செய்
        await page.evaluate(() => {
            const navItems = Array.from(document.querySelectorAll('div, span'));
            const winGoBtn = navItems.find(el => el.innerText.trim() === 'Win Go');
            if (winGoBtn) winGoBtn.click();
        });

        // 6. டோக்கன் கிடைச்சதான்னு 15 வினாடி வரை செக் பண்ணு
        for (let i = 0; i < 15; i++) {
            if (capturedToken) break;
            await new Promise(r => setTimeout(r, 1000));
        }

        if (capturedToken) {
            userTokens[userId] = capturedToken;
            console.log("✅ [SUCCESS] Token captured successfully!");
            if (!silent && chatId) await send(chatId, "✅ Login & Token Capture Success!");
            return true;
        } else {
            throw new Error("Token not found in requests.");
        }

    } catch (err) {
        console.error("❌ Login Error:", err.message);
        return false;
    } finally {
        await browser.close();
        loginLock[userId] = false;
    }
}

// ============================================================
//  PERIODIC AUTO-LOGIN (NEW FEATURE)
// ============================================================
setInterval(async () => {
    console.log("[AUTO-LOGIN] Initiating periodic login check for all users...");
    for (const userId in userCreds) {
        if (userCreds[userId].phone && userCreds[userId].pass) {
            let loginSuccess = false;
            let retries = 0;
            const maxRetries = 3; // Allow a few retries for periodic login

            while (!loginSuccess && retries < maxRetries) {
                console.log(`[AUTO-LOGIN] Attempting login for user ${userId} (Retry: ${retries + 1}/${maxRetries})...`);
                loginSuccess = await autoLogin(userId, null, true); // Silent login, no chat ID needed for periodic check
                if (!loginSuccess) {
                    retries++;
                    console.log(`[AUTO-LOGIN] Login failed for user ${userId}. Retrying in 10 seconds...`);
                    await sleep(10000); // Wait 10 seconds before retrying
                }
            }

            if (loginSuccess) {
                console.log(`[AUTO-LOGIN] User ${userId} successfully logged in.`);
            } else {
                console.error(`[AUTO-LOGIN] Failed to log in user ${userId} after ${maxRetries} attempts.`);
                // Optionally, notify the user via Telegram if login consistently fails
                // await send(userId, "⚠️ Auto-login failed. Please check your credentials.");
            }
        }
    }
}, 15 * 60 * 1000); // Every 15 minutes

// ============================================================
//  PLACE BET (Modified to capture token from response if available)
// ============================================================
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
        random:      Math.floor(Math.random() * 1000000000000000).toString(),
        signature:   "",
        timestamp:   Date.now(),
        token:       token,
        track:       0,
        type:        1,
        userId:      userId
    };
    params.signature = makeBetSign(params);

    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios.post(BET_URL, params, {
                headers: {
                    "Accept": "application/json, text/plain, */*",
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${token}`,
                    "Origin": "https://bdgwin901.com",
                    "Referer": "https://bdgwin901.com/",
                    "Ar-Origin": "https://bdgwin901.com",
                    "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
                },
                timeout: 10000
            });

            if (response.data && response.data.code === 0) {
                console.log("✅ [BET SUCCESS]", response.data);
                return { ok: true, bc, amt: betMult };
            } else {
                console.error("❌ [BET ERROR]", response.data);
                if (response.data?.code === 100001) { // Token invalid or expired
                    console.log("[BET] Token expired, attempting re-login...");
                    const reLoggedIn = await autoLogin(userId, chatId, true);
                    if (reLoggedIn) {
                        token = getToken(userId); // Update token after successful re-login
                        params.token = token;
                        params.signature = makeBetSign(params); // Re-sign with new token
                        continue; // Retry bet with new token
                    } else {
                        await send(chatId, "❌ Login failed after token expiry. Please /setcreds again.");
                        return { ok: false, msg: "Login failed after token expiry." };
                    }
                }
            }
        } catch (error) {
            console.error("[BET AXIOS ERROR]", error.message);
        }
        await sleep(retryDelayMs); // Wait before retrying
    }
    await send(chatId, "❌ Bet failed after multiple retries.");
    return { ok: false, msg: "Bet failed after multiple retries." };
}

function initState(userId) {
    if (!userStates[userId]) userStates[userId] = { history:[], mode:"NORMAL", recoveryCount:0 };
}

function decidePrediction(list, currentLevel, userId) {
    initState(userId);
    const state = userStates[userId];

    // Previous result 0னா prediction வேண்டாம்
    if (list[0].number === 0 || list[0].winNumber === 0) {
        return null;
    }
    
    const currentPeriod = String(list[0].issueNumber);
    const currentResult = parseInt(list[0].number || list[0].winNumber || 0);

    // STEP 1: Calculate next period
    const nextPeriodNum = BigInt(currentPeriod) + 1n;
    const nextPeriod = nextPeriodNum.toString();
    const nextLast3Num = parseInt(nextPeriod.slice(-3));

    // STEP 2: Calculate: NEXT_LAST_3 × exp(CURRENT_RESULT)
    const answer = nextLast3Num * Math.exp(currentResult);

    // STEP 3: Get 14 digits (remove decimal, take first 14)
    const answerStr = answer.toString();
    const noDecimal = answerStr.replace('.', '');
    const first14 = noDecimal.substring(0, 14);

    // STEP 4: Get last digit
    const lastDigit = parseInt(first14.charAt(first14.length - 1));

    // STEP 5: Apply logic based on MODE
    let prediction = lastDigit <= 4 ? 'SMALL' : 'BIG';

    // RECOVERY மோட்ல மட்டும் ஆப்போசிட் பண்ணுவோம்
    if (state.mode === 'RECOVERY') {
        prediction = (prediction === 'SMALL') ? 'BIG' : 'SMALL';
    }

    return { 
        type: 'SIZE', 
        val: prediction, 
        conf: 90, 
        pat: state.mode 
    };
}

function updateAfterResult(userId, wasWin, currentResult) {
    initState(userId);
    const state = userStates[userId];

    if (currentResult === 0) {
        state.history = [];
        state.mode = "NORMAL";
        return; 
    }

    // எக்ஸ்ட்ரா வேரியபிள்ஸ் இல்லைனா செட் பண்ணிக்கிறோம்
    if (!state.history) state.history = [];
    if (state.recoveryCount === undefined) state.recoveryCount = 0;

    // 1. ஏற்கனவே RECOVERY மோடு ஆக்டிவ் ஆக இருந்தால்
    if (state.mode === "RECOVERY") {
        if (wasWin) {
            // If a bet wins in RECOVERY mode, immediately switch back to NORMAL
            state.mode = "NORMAL";
            state.history = [];  // Reset history
            state.recoveryCount = 0;
            console.log(`[RECOVERY MODE] User ${userId} won, switching to NORMAL mode.`);
        } else {
            state.recoveryCount -= 1; // Decrement count on loss in recovery
            // If recoveryCount drops to 0 or less, switch to NORMAL mode
            if (state.recoveryCount <= 0) {
                state.mode = "NORMAL";
                state.history = [];  // Reset history
                state.recoveryCount = 0;
                console.log(`[RECOVERY MODE] User ${userId} recovery attempts exhausted, switching to NORMAL mode.`);
            }
        }
        // RECOVERY மோடுல நடக்குற கேம் ரிசல்ட்ஸ் பழைய நார்மல் பேட்டர்னை பாதிக்கக் கூடாது என்பதால் return செய்கிறோம்
        return; 
    }

    // 2. NORMAL மோடு ஹிஸ்ட்ரி மெயின்டைன் பண்ணுவோம் (கடைசி 10 ரிசல்ட்ஸ்)
    state.history.push(wasWin ? 'W' : 'L');
    if (state.history.length > 10) state.history.shift();

    const histStr = state.history.join(',');

    // 3. அல்ட்ரா பேட்டர்ன் அனாலிசிஸ் (4 அல்லது அதற்கு மேற்பட்ட தொடர் நஷ்டங்கள்)
    // எ.கா: L,L,L,L அல்லது W,L,L,L,L
    if (/(W,L,L,L,L,L+)$/.test(histStr)) { // This regex matches 5 or more consecutive losses (L,L,L,L,L or W,L,L,L,L,L)
        state.mode = "RECOVERY";
        state.recoveryCount = 5; // Changed from 3 to 5 recovery predictions
        state.history = [];      // பேட்டர்ன் மேட்ச் ஆன உடனே பழைய நார்மல் ஹிஸ்டரி ரீசெட்!
        console.log(`[NORMAL MODE] User ${userId} entered RECOVERY mode with 5 attempts.`);
    }

    // எந்த பேட்டர்னும் இல்லைனா நார்மலாவே தொடரும்
    else {
        state.mode = "NORMAL";
    }
}

function getStatus(userId) {
    initState(userId);
    const state = userStates[userId];
    return state.mode === 'NORMAL' ? `NORMAL` : `RECOVERY (${state.recoveryCount}/5)`; // Updated display for 5 levels
}

function shouldBet(userId) {
    initState(userId);
    const state = userStates[userId];
    
    // Prediction எப்போதும் வரணும், ஆனா patterns ஆக்டிவ் ஆகும் போது மட்டும் (RECOVERY) பெட் பண்ணனும்
    return state.mode === 'RECOVERY';
    
}

function shouldBetNow(userId) {
    const cfg = autobetCfg[userId], st = autobetState[userId];
    if (!cfg.enabled) return false;
    if (st.inMart) return true;
    if (cfg.watch && st.consecutiveLoss < cfg.watchLoss) return false;
    return true;
}

async function handleWin(userId, chatId, actual, num) {
    const st=autobetState[userId],pt=profitTrack[userId],cfg=autobetCfg[userId];
    const amt=cfg.customBets[st.level-1] || (cfg.baseBet*MULT[st.level-1]),profit=amt*0.98;
    pt.totalBets++;pt.wins++;pt.pnl+=profit; pt.totalBetAmount = (pt.totalBetAmount || 0) + amt;
    pt.winStreak++;pt.lossStreak=0;if(pt.winStreak>pt.maxW)pt.maxW=pt.winStreak;
    st.level=1;st.inMart=false;st.consecutiveLoss=0;
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

    const list = await fetchList();
    if(!list){
        await send(chatId,"⚠️ API error — retrying in 15s...");
        return setTimeout(()=>runPredict(userId,chatId), 15000);
    }

    const next   = (BigInt(list[0].issueNumber)+1n).toString();
    const signal = decidePrediction(
        list,
        autobetState[userId].level,
        userId
    );
    const data10=list.slice(0,10).map(parseItem);
    const szS=stk(data10,"size"),clS=stk(data10,"color");
    
    const dragonInfo=szS.count>=6?"🐉 SIZE:"+szS.val+" x"+szS.count:clS.count>=6?"🐉 COLOR:"+clS.val+" x"+clS.count:"";

    if(!signal){
        const sk="SK_"+next;
        if(!sentPeriods[userId].has(sk)){
            sentPeriods[userId].add(sk);
            await send(chatId,
"╔══════════════════════════╗\n"+
"║   ⏭️ SKIP                ║\n"+
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

    const st=autobetState[userId],cfg=autobetCfg[userId];
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
        {reply_markup:{inline_keyboard:[[{text:"💰 GOAOKO PLAY NOW",url:REG_LINK}]]}}
    );

    // ✅ Pattern iruntha mattum bet kattum
    if (cfg.enabled && shouldBet(userId)) { 
        const result = await placeBet(userId, chatId, next, signal.val, signal.type, st.level);
        if (result && result.ok) {
            await send(chatId, "✅ Bet Success! " + result.bc + " ₹" + result.amt + " L" + st.level + "\n⏳ Checking result...");
        }
    } else if (cfg.enabled) {
        console.log("👀 No pattern, skipping bet.");
    }

    checkResult(userId, chatId, next, signal.val, signal.type);
}
// ============================================================
//  RESULT CHECKER
// ============================================================
async function checkResult(userId, chatId, target, predicted, predType) {
    let tries=0;
    const cfg=autobetCfg[userId],st=autobetState[userId];
    // ✅ Bet kattiruntha mattum wasReal true aagum
    const wasReal=cfg.enabled && shouldBet(userId);
    
    const iv=setInterval(async()=>{
        if(!running[userId])return clearInterval(iv);
        if(++tries>20){
            clearInterval(iv);
            await send(chatId,"⏱ Timeout — next...");
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

        updateAfterResult(userId, win, num); // Pass num as currentResult

        const s = stats[userId];
        s.total++;
        if(win){s.win++;s.winStreak++;s.lossStreak=0;if(s.winStreak>s.maxWinStreak)s.maxWinStreak=s.winStreak;}
        else{s.loss++;s.lossStreak++;s.winStreak=0;if(s.lossStreak>s.maxLossStreak)s.maxLossStreak=s.lossStreak;}

        if(cfg.enabled && wasReal){
            // ✅ Bet kattiruntha mattum handleWin/handleLoss (Level change aagum)
            if(win) await handleWin(userId,chatId,actual,num);
            else    await handleLoss(userId,chatId,actual,num);
        } else if (cfg.enabled) {
            // ✅ Bet kattala-na level change aagaathu
            if(win) await send(chatId,"👀 Watch ✅ Correct! (No bet placed)");
            else    await send(chatId,"👀 Watch ❌ Incorrect! (No bet placed)");
        } else {
            // Manual mode
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
function autobetStatus(chatId,userId){
    const cfg=autobetCfg[userId],st=autobetState[userId],pt=profitTrack[userId];
    const amounts=cfg.customBets.slice(0,cfg.maxLvl);
    const creds=userCreds[userId]||{};
    send(chatId,
"🤖 AUTOBET STATUS\n\n"+
"Enabled  : "+(cfg.enabled?"✅ ON":"❌ OFF")+"\n"+
"Token    : "+(getToken(userId).length>20?"✅":"❌")+"\n"+
"AutoLogin: "+(creds.phone?"✅ "+creds.phone.slice(0,6)+"***":"❌")+"\n"+
"Watch    : "+(cfg.watch?"ON":"OFF")+"\n"+
"WatchLoss: "+st.consecutiveLoss+"/"+cfg.watchLoss+"\n"+
"Base Bet : ₹"+cfg.baseBet+"\n"+
"Max Level: "+cfg.maxLvl+"\n"+
"Mart Lvl : L"+st.level+"\n"+
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
const autobetMenu={keyboard:[["✅ Enable AutoBet","❌ Disable AutoBet"],["👀 Watch Mode ON","👀 Watch Mode OFF"],["💰 Set Base Bet","📈 Set Max Level"],["🔢 Set Watch Losses","📊 AutoBet Status"],["📝 Set Custom Bets","🔙 Back"]],resize_keyboard:true};

// ============================================================
//  BOT INIT
// ============================================================
let bot;
function startBot(){
    if(bot){try{bot.stopPolling();}catch(e){}}
    bot=new TelegramBot(BOT_TOKEN,{polling:{interval:1000,autoStart:true,params:{timeout:30}}});
    bot.on("polling_error",err=>{console.error("Poll:",err.message);setTimeout(startBot,5000);});
    bot.on("error",err=>{console.error("Bot:",err.message);});
    addHandlers();
    console.log("✅ SIVA BOT running...");
}
async function send(chatId,text,opts={}){
    try{return await bot.sendMessage(chatId,text,opts);}
    catch(e){if(e.message&&e.message.includes("parse entities")){try{const o={...opts};delete o.parse_mode;return await bot.sendMessage(chatId,text,o);}catch(e2){}}console.error("send:",e.message?.substr(0,60));}
}
async function sendSticker(chatId,sid){try{await bot.sendSticker(chatId,sid);}catch(e){}}

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

    bot.onText(/\/setcreds (.+)/,async (msg,match)=>{
        const id=msg.from.id;
        if(!hasAccess(id))return send(id,"❌ No access.");
        const parts=match[1].trim().split(/\s+/);
        if(parts.length<2)return send(id,"❌ Format:\n/setcreds FULLPHONE PASSWORD\n\nExample:\n/setcreds 916381605525 mypassword");
        const phone=parts[0],pass=parts.slice(1).join(" ");
        if(!userCreds[id])userCreds[id]={};
        userCreds[id].phone=phone;userCreds[id].pass=pass;
        await send(id,"✅ Saved!\n📱 "+phone+"\n🔄 Testing login...");
        
        let loginSuccess = false;
        let retries = 0;
        const maxRetries = 5; // Allow more retries for initial setcreds login

        while (!loginSuccess && retries < maxRetries) {
            console.log(`[SETCREDS] Attempting login for user ${id} (Retry: ${retries + 1}/${maxRetries})...`);
            loginSuccess = await autoLogin(id, msg.chat.id, false); // Not silent, send messages to user
            if (!loginSuccess) {
                retries++;
                if (retries < maxRetries) {
                    await send(id, `❌ Login failed. Retrying in 5 seconds... (${retries}/${maxRetries})`);
                    await sleep(5000); // Wait 5 seconds before retrying
                } else {
                    await send(id, "❌ Login failed after multiple attempts. Please check your credentials and try again.");
                }
            }
        }
        if (loginSuccess) {
            await send(id, "✅ Login successful with new credentials!");
        }
    });

    bot.onText(/\/setmytoken (.+)/,(msg,match)=>{
        const id=msg.from.id;
        if(!hasAccess(id))return send(id,"❌ No access.");
        const tok=match[1].trim().replace(/^Bearer\s+/i,"");
        if(tok.length<20)return send(id,"❌ Token too short!");
        userTokens[id]=tok;
        send(id,"✅ Token saved!\n..."+tok.slice(-12)+"\n\n🤖 AutoBet Setup → ✅ Enable");
    });

    bot.onText(/\/login/,(msg)=>{
        const id=msg.from.id;
        if(!hasAccess(id))return send(id,"❌ No access.");
        send(id,"🔄 Logging in...");
        autoLogin(id,msg.chat.id,false);
    });

    bot.onText(/\/owner/,(msg)=>{
        if(msg.from.id!==OWNER_ID)return;
        if(ownerLoggedIn)return send(OWNER_ID,"Already in!",{reply_markup:ownerMenu});
        ownerState={action:"login"};send(OWNER_ID,"🔐 Owner password:");
    });

    bot.onText(/\/adminlogin (.+)/,(msg,match)=>{
        const id=msg.from.id,pass=match[1].trim();
        if(!isAdmin(id))return send(id,"Not admin.");
        if(pass===adminPasswords[id]){adminLoggedIn[id]=true;send(id,"✅ Admin Login!",{reply_markup:userMenu(id)});}
        else send(id,"❌ Wrong!");
    });

    bot.on("message",async msg=>{
        const id=msg.from.id,text=msg.text;
        if(!text||text.startsWith("/"))return;
        initUser(id);

        const OB=["👥 All Users","👮 All Admins","👤 Add Admin","🗑 Remove Admin","🔑 Generate Key","📋 All Keys","🟢 Add User","🔴 Remove User","🔐 Set Token","📊 All Status","🚪 Owner Logout"];
        const AB=["👥 Active Users","🔑 Generate Key","🟢 Add User","🔴 Remove User","📋 All Keys","🚪 Admin Logout"];

        if(id===OWNER_ID&&ownerState){
            const s=ownerState;
            if(s.action==="login"){if(text===OWNER_PASS){ownerLoggedIn=true;ownerState=null;return send(OWNER_ID,"👑 Welcome!",{reply_markup:ownerMenu});}else return send(OWNER_ID,"❌ Wrong!");}
            if(OB.includes(text)){ownerState=null;}
            else if(s.action==="addadmin"){if(!s.step2){const t=parseInt(text);if(isNaN(t))return send(OWNER_ID,"❌");ownerState={action:"addadmin",step2:true,tid:t};return send(OWNER_ID,"ID:"+t+"\nPassword:");}else{if(text.length<6)return send(OWNER_ID,"❌ Min 6");adminPasswords[s.tid]=text;adminLoggedIn[s.tid]=false;ownerState=null;send(OWNER_ID,"✅ Admin: "+s.tid,{reply_markup:ownerMenu});send(s.tid,"🎉 Admin!\n/adminlogin "+text);return;}}
            else if(s.action==="removeadmin"){const t=parseInt(text);if(isNaN(t))return;delete adminPasswords[t];delete adminLoggedIn[t];ownerState=null;send(OWNER_ID,"🚫 Removed",{reply_markup:ownerMenu});return;}
            else if(s.action==="genkey"){const d=parseInt(text);if(isNaN(d)||d<1)return send(OWNER_ID,"❌ Days?");const k=generateKey(d,OWNER_ID);ownerState=null;return send(OWNER_ID,"🔑 Key:\n\n"+k+"\n\n"+d+"d\n/key "+k,{reply_markup:ownerMenu});}
            else if(s.action==="adduser"){if(!s.step2){const t=parseInt(text);if(isNaN(t))return send(OWNER_ID,"❌");ownerState={action:"adduser",step2:true,tid:t};return send(OWNER_ID,"ID:"+t+"\nDays?");}else{const d=parseInt(text);if(isNaN(d)||d<1)return send(OWNER_ID,"❌");usersAccess[s.tid]=Date.now()+d*86400000;ownerState=null;send(OWNER_ID,"✅ "+s.tid+" "+d+"d",{reply_markup:ownerMenu});send(s.tid,"🎊 VIP! "+d+" days\n▶️ Start Prediction!");return;}}
            else if(s.action==="removeuser"){const t=parseInt(text);if(isNaN(t))return;const was=hasAccess(t);delete usersAccess[t];running[t]=false;ownerState=null;send(OWNER_ID,was?"🚫 Removed":"⚠️ Not active",{reply_markup:ownerMenu});if(was)send(t,"🔴 Access removed.");return;}
            else if(s.action==="settoken"){GLOBAL_TOKEN=text.trim().replace(/^Bearer\s+/i,"");ownerState=null;return send(OWNER_ID,"✅ Global Token set!",{reply_markup:ownerMenu});}
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
                    const s = stats[uid];
                    const pnlStr = (pt.pnl >= 0 ? "+" : "") + pt.pnl.toFixed(2);
                    
                    report += `👤 ID: ${uid}\n`;
                    report += `💰 Total Bet: ₹${(pt.totalBetAmount || 0).toFixed(2)}\n`;
                    report += `📈 Profit: ₹${pnlStr}\n`;
                    report += `📉 Max Loss: ${pt.maxL || 0} streak\n`;
                    report += `🔥 Win Strike: ${pt.maxW || 0} streak\n`;
                    report += `🎮 Playing Level: L${st.level}\n`;
                    report += `📊 Win/Loss: ${pt.wins}W / ${pt.losses}L\n`;
                    report += `------------------------\n`;
                });
                return send(OWNER_ID, report);
            }
            if(text==="🚪 Owner Logout") {ownerLoggedIn=false;return send(OWNER_ID,"🔒 Out.",{reply_markup:userMenu(id)});}
        }

        // --- Admin Input Handling ---
        if(isAdmin(id) && isAdminIn(id) && adminState[id]){
            const s = adminState[id];
            if(AB.includes(text)){ delete adminState[id]; }
            else if(s.action==="genkey"){const d=parseInt(text);if(isNaN(d)||d<1)return send(id,"❌ Days?");const k=generateKey(d,id);delete adminState[id];return send(id,"🔑 Key:\n\n"+k+"\n\n"+d+"d",{reply_markup:adminMenu});}
            else if(s.action==="adduser"){if(!s.step2){const t=parseInt(text);if(isNaN(t))return send(id,"❌");adminState[id]={action:"adduser",step2:true,tid:t};return send(id,"ID:"+t+"\nDays?");}else{const d=parseInt(text);if(isNaN(d)||d<1)return send(id,"❌");usersAccess[s.tid]=Date.now()+d*86400000;delete adminState[id];send(id,"✅ "+s.tid+" "+d+"d",{reply_markup:adminMenu});send(s.tid,"🎊 ACCESS! "+d+"d");return;}}
            else if(s.action==="removeuser"){const t=parseInt(text);if(isNaN(t))return;const was=hasAccess(t);delete usersAccess[t];running[t]=false;delete adminState[id];send(id,was?"🚫 Removed":"⚠️ Not active",{reply_markup:adminMenu});if(was)send(t,"🔴 Removed.");return;}
            else if(s.action==="allKeysList")     return send(id,"📋\n\n"+allKeysList());
        }

        // --- User Settings Input Handling ---
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
                return send(id, "✅ Max Level Updated: " + v + "\nMartingale: ₹" + a.join("→₹"), {reply_markup: autobetMenu});
            }
            else if(s.action === "setwloss"){
                const v = parseInt(text);
                if(isNaN(v) || v < 0) return send(id, "❌ Invalid Count! Enter 0 or more.");
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
        if(text==="💰 Set Base Bet"){userAction[id]={action:"setbase"};return send(id,"💰 Enter Base Bet Amount (₹):\n(Current: ₹"+autobetCfg[id].baseBet+")");}
        if(text==="📈 Set Max Level"){userAction[id]={action:"setlvl"};const a=MULT.slice(0,10).map(m=>autobetCfg[id].baseBet*m);return send(id,"📈 Enter Max Martingale Level (1-10):\n(Current: "+autobetCfg[id].maxLvl+")\n\nExample Amounts:\n"+a.map((v,i)=>"L"+(i+1)+": ₹"+v).join("\n"));}
        if(text==="🔢 Set Watch Losses"){userAction[id]={action:"setwloss"};return send(id,"🔢 Enter Watch Loss Count:\n(Current: "+autobetCfg[id].watchLoss+")\n\nExample: 3 means bot waits for 3 losses, then starts betting.");}
        if(text==="📝 Set Custom Bets"){userAction[id]={action:"setcustom"};return send(id,"📝 Enter Custom Bet Sequence (comma separated):\nExample: 1,4,7,9,15\n\n(This will also update your Max Level automatically)");}
        if(text==="📊 AutoBet Status")return autobetStatus(msg.chat.id,id);
        if(text==="🔙 Back")return send(id,"Main Menu",{reply_markup:userMenu(id)});

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
            const cfg=autobetCfg[id];
            await send(msg.chat.id,
"🚀 ENGINE ON!\n\nAutoBet: "+(cfg.enabled?"✅ ON":"❌ OFF")+"\nWatch  : "+(cfg.watch?"ON ("+cfg.watchLoss+"L)":"OFF")+"\nBase   : ₹"+cfg.baseBet+" | MaxLvl: "+cfg.maxLvl
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
