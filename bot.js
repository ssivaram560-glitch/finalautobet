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
//  LOGGING HELPER (New)
// ============================================================
async function logBoth(chatId, msg, isError = false) {
    if (isError) console.error(msg);
    else console.log(msg);
    if (chatId) {
        if (bot) {
            try {
                await bot.sendMessage(chatId, msg);
            } catch (e) {
                // Ignore
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

function initUser(id) {
    if (!stats[id])        stats[id]        = { total:0,win:0,loss:0,lossStreak:0,winStreak:0,maxWinStreak:0,maxLossStreak:0 };
    if (!userStates[id])   userStates[id]   = { history:[], mode:"NORMAL", recoveryCount:0 };
    if (!sentPeriods[id])  sentPeriods[id]  = new Set();
    if (!autobetCfg[id])   autobetCfg[id]   = { 
        watch:false, 
        watchLoss:5, 
        baseBet:1, 
        maxLvl:5, 
        enabled:false, 
        customBets:[1,3,9,27,81],
        targetProfit: 1000,    // Default target profit
        restartDelay: 1        // Default restart delay in hours
    };
    if (!autobetState[id]) autobetState[id] = { level:1, consecutiveLoss:0, inMart:false, isWaiting: false, nextStartTime: null };
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
            // Ignore timeout
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

async function robustLogin(userId, chatId, silent = false) {
    let success = await autoLogin(userId, chatId, silent);
    if (!success && !silent && chatId) {
        await logBoth(chatId, "❌ Login failed. Will retry automatically.");
    }
    return success;
}

async function placeBet(userId, chatId, period, prediction, predType, level) {
    let token = getToken(userId);
    if (!token || token.length < 20) {
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

    if (predType==="SIZE")  bc = prediction==="BIG" ? "BigSmall_Big" : "BigSmall_Small";
    if (predType==="COLOR") bc = prediction==="RED" ? "Color_Red"    : "Color_Green";

    const params = {
        amount: betMult,
        betType: predType === "SIZE" ? 1 : 2,
        betValue: bc,
        issueNumber: period,
        lotteryId: 1 // Win Go 30s
    };

    try {
        const r = await axios.post(BET_URL, params, {
            headers: {
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
                "Ar-Origin": "https://bdgwin901.com",
                "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
            }
        });
        if (r.data && r.data.code === 0) {
            return { ok: true, bc, amt: betMult };
        } else {
            console.error("[BET ERR]", r.data?.message || "Unknown error");
            return { ok: false, msg: r.data?.message };
        }
    } catch (e) {
        console.error("[BET EXCEPTION]", e.message);
        return { ok: false, msg: e.message };
    }
}

// ============================================================
//  LOGIC
// ============================================================
function decidePrediction(list, level, userId) {
    initUser(userId);
    const state = userStates[userId];
    const currentPeriod = list[0].issueNumber;
    const currentResult = parseInt(list[0].number || list[0].winNumber || 0);

    const nextPeriodNum = BigInt(currentPeriod) + 1n;
    const nextPeriod = nextPeriodNum.toString();
    const nextLast3Num = parseInt(nextPeriod.slice(-3));

    const answer = nextLast3Num * Math.exp(currentResult);
    const answerStr = answer.toString();
    const noDecimal = answerStr.replace('.', '');
    const first14 = noDecimal.substring(0, 14);
    const lastDigit = parseInt(first14.charAt(first14.length - 1));

    let prediction = lastDigit <= 4 ? 'SMALL' : 'BIG';

    return { 
        type: 'SIZE', 
        val: prediction, 
        conf: 99, 
        pat: state.mode 
    };
}

function updateAfterResult(userId, wasWin) {
    initUser(userId);
    const state = userStates[userId];
    state.history.push(wasWin ? 'W' : 'L');
    if (state.history.length > 10) state.history.shift();
    state.mode = "NORMAL";
    state.recoveryCount = 0;
}

function getStatus(userId) {
    initUser(userId);
    const state = userStates[userId];
    const hist = state.history.join(',') || "EMPTY";
    return `NORMAL | History: [${hist}]`;
}

function shouldBet(userId) {
    initUser(userId);
    const state = userStates[userId];
    const histStr = state.history.join(',');
    return /L,W,W,W,W,W,L$/.test(histStr);
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

    // Check if waiting for restart
    const st=autobetState[userId];
    const cfg=autobetCfg[userId];
    if (st.isWaiting) {
        if (Date.now() >= st.nextStartTime) {
            st.isWaiting = false;
            st.nextStartTime = null;
            profitTrack[userId].pnl = 0; // Reset PNL for new session
            await send(chatId, "🔄 Timed restart! Profit target reached previously. Starting new section now...");
        } else {
            const timeLeft = Math.round((st.nextStartTime - Date.now()) / 60000);
            console.log(`[WAIT] User ${userId} waiting for restart. ${timeLeft} mins left.`);
            return setTimeout(()=>runPredict(userId,chatId), 60000);
        }
    }

    const list = await fetchList();
    if(!list){
        await logBoth(chatId, "⚠️ API error — retrying in 15s...");
        return setTimeout(()=>runPredict(userId,chatId), 15000);
    }

    const next   = (BigInt(list[0].issueNumber)+1n).toString();
    const signal = decidePrediction(list, autobetState[userId].level, userId);
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

        updateAfterResult(userId, win);

        const s = stats[userId];
        s.total++;
        if(win){s.win++;s.winStreak++;s.lossStreak=0;if(s.winStreak>s.maxWinStreak)s.maxWinStreak=s.winStreak;}
        else{s.loss++;s.lossStreak++;s.winStreak=0;if(s.lossStreak>s.maxLossStreak)s.maxLossStreak=s.lossStreak;}

        if(cfg.enabled && wasReal){
            if(win) await handleWin(userId,chatId,actual,num);
            else    await handleLoss(userId,chatId,actual,num);

            // --- PROFIT STOP & TIMED RESTART LOGIC ---
            if (pt.pnl >= cfg.targetProfit) {
                st.isWaiting = true;
                st.nextStartTime = Date.now() + (cfg.restartDelay * 60 * 60 * 1000);
                const restartTimeStr = new Date(st.nextStartTime).toLocaleTimeString();
                await send(chatId, 
                    "🎯 TARGET REACHED!\n\n" +
                    "Profit Target: ₹" + cfg.targetProfit + "\n" +
                    "Current P&L: ₹" + pt.pnl.toFixed(2) + "\n\n" +
                    "🛑 Bot stopping now...\n" +
                    "⏳ Section Delay: " + cfg.restartDelay + " hour(s)\n" +
                    "🔄 Next Section Start: " + restartTimeStr + "\n\n" +
                    "Bot will restart automatically."
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
function autobetStatus(chatId,userId){
    const cfg=autobetCfg[userId],st=autobetState[userId],pt=profitTrack[userId];
    const amounts=cfg.customBets.slice(0,cfg.maxLvl);
    const creds=userCreds[userId]||{};
    let waitLine = "";
    if (st.isWaiting) {
        const diff = Math.round((st.nextStartTime - Date.now()) / 60000);
        waitLine = "\n⏳ Waiting: " + diff + " mins to restart";
    }
    send(chatId,
"🤖 AUTOBET STATUS\n\n"+
"Enabled  : "+(cfg.enabled?"✅ ON":"❌ OFF")+"\n"+
"Token    : "+(getToken(userId).length>20?"✅":"❌")+"\n"+
"AutoLogin: "+(creds.phone?"✅ "+creds.phone.slice(0,6)+"***":"❌")+"\n"+
"Watch    : "+(cfg.watch?"ON":"OFF")+"\n"+
"WatchLoss: "+st.consecutiveLoss+"/"+cfg.watchLoss+"\n"+
"Base Bet : ₹"+cfg.baseBet+"\n"+
"Max Level: "+cfg.maxLvl+"\n"+
"Target Profit: ₹"+cfg.targetProfit+"\n"+
"Section Delay: "+cfg.restartDelay+" hr"+
waitLine+"\n"+
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
    console.log("🕒 [TASK] Auto-login scheduler started (10 mins)");
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
        const status=hasAccess(id)?"✅ ACTIVE":"❌ EXPIRED";
        send(id,"👋 Welcome to EARN WITH ME AI!\n\nStatus: "+status+"\nDays Left: "+daysLeft(id)+"\n\nUse buttons below to start.",{reply_markup:userMenu(id)});
    });

    bot.on("message",async(msg)=>{
        const id=msg.from.id,txt=msg.text;
        if(!txt)return;
        initUser(id);

        // Access check
        if(!hasAccess(id)&&!isAdmin(id)&&id!==OWNER_ID&&!txt.startsWith("/start")&&!txt.startsWith("/activate")){
            return send(id,"❌ Your access has expired. Contact @OnlineEarningapp_bot to renew.");
        }

        // --- OWNER HANDLERS ---
        if(id===OWNER_ID){
            if(txt==="🚪 Owner Logout"){ownerLoggedIn=false;return send(id,"Logged out.",{reply_markup:{remove_keyboard:true}});}
            if(!ownerLoggedIn){
                if(txt===OWNER_PASS){ownerLoggedIn=true;return send(id,"Welcome Boss!",{reply_markup:ownerMenu});}
                return;
            }
            if(txt==="👥 All Users") return send(id,activeUsersList());
            if(txt==="👮 All Admins") return send(id,adminList());
            if(txt==="📋 All Keys") return send(id,allKeysList());
            if(txt==="👤 Add Admin"){ownerState="ADD_ADMIN";return send(id,"Send User ID to make Admin:");}
            if(txt==="🗑 Remove Admin"){ownerState="REM_ADMIN";return send(id,"Send User ID to remove Admin:");}
            if(txt==="🔑 Generate Key"){ownerState="GEN_KEY";return send(id,"How many days? (e.g. 7)");}
            if(txt==="🟢 Add User"){ownerState="ADD_USER";return send(id,"Send User ID and Days (e.g. 12345 30):");}
            if(txt==="🔴 Remove User"){ownerState="REM_USER";return send(id,"Send User ID to remove:");}
            if(txt==="🔐 Set Token"){ownerState="SET_TOKEN";return send(id,"Send Global Token:");}
            if(txt==="📊 All Status") return send(id,"Stats and sessions are in memory.");

            if(ownerState==="ADD_ADMIN"){
                adminPasswords[txt]=true;ownerState=null;
                return send(id,"✅ "+txt+" is now Admin.");
            }
            if(ownerState==="REM_ADMIN"){
                delete adminPasswords[txt];ownerState=null;
                return send(id,"✅ "+txt+" removed from Admins.");
            }
            if(ownerState==="GEN_KEY"){
                const d=parseInt(txt);if(isNaN(d))return send(id,"Invalid days.");
                const k=generateKey(d,"OWNER");ownerState=null;
                return send(id,"✅ Key Generated:\n`"+k+"` (Tap to copy)",{parse_mode:"Markdown"});
            }
            if(ownerState==="ADD_USER"){
                const [uid,days]=txt.split(" ");
                if(!uid||!days)return send(id,"Format: ID Days");
                usersAccess[uid]=Date.now()+parseInt(days)*86400000;ownerState=null;
                return send(id,"✅ User "+uid+" added for "+days+" days.");
            }
            if(ownerState==="REM_USER"){
                delete usersAccess[txt];ownerState=null;
                return send(id,"✅ User "+txt+" access removed.");
            }
            if(ownerState==="SET_TOKEN"){
                GLOBAL_TOKEN=txt;ownerState=null;
                return send(id,"✅ Global Token updated.");
            }
        }

        // --- ADMIN HANDLERS ---
        if(isAdmin(id)){
            if(txt==="🚪 Admin Logout"){adminLoggedIn[id]=false;return send(id,"Logged out.",{reply_markup:userMenu(id)});}
            if(!adminLoggedIn[id]){
                if(txt==="👑 Admin Panel") return send(id,"Enter Admin Password:");
                if(txt==="2004"){adminLoggedIn[id]=true;return send(id,"Welcome Admin!",{reply_markup:adminMenu});}
                if(txt.length===4) return send(id,"Wrong password.");
            } else {
                if(txt==="👥 Active Users") return send(id,activeUsersList());
                if(txt==="📋 All Keys") return send(id,allKeysList());
                if(txt==="🔑 Generate Key"){adminState[id]="GEN_KEY";return send(id,"How many days? (e.g. 7)");}
                if(txt==="🟢 Add User"){adminState[id]="ADD_USER";return send(id,"Send User ID and Days (e.g. 12345 30):");}
                if(txt==="🔴 Remove User"){adminState[id]="REM_USER";return send(id,"Send User ID to remove:");}

                if(adminState[id]==="GEN_KEY"){
                    const d=parseInt(txt);if(isNaN(d))return send(id,"Invalid days.");
                    const k=generateKey(d,id);adminState[id]=null;
                    return send(id,"✅ Key Generated:\n`"+k+"` (Tap to copy)",{parse_mode:"Markdown"});
                }
                if(adminState[id]==="ADD_USER"){
                    const [uid,days]=txt.split(" ");
                    if(!uid||!days)return send(id,"Format: ID Days");
                    usersAccess[uid]=Date.now()+parseInt(days)*86400000;adminState[id]=null;
                    return send(id,"✅ User "+uid+" added for "+days+" days.");
                }
                if(adminState[id]==="REM_USER"){
                    delete usersAccess[txt];adminState[id]=null;
                    return send(id,"✅ User "+txt+" access removed.");
                }
            }
        }

        // --- USER HANDLERS ---
        if(txt==="▶️ Start Prediction"){
            if(running[id])return send(id,"Already running.");
            running[id]=true;
            send(id,"🚀 Prediction Started! Waiting for next period...");
            runPredict(id,id);
        }
        if(txt==="🛑 Stop"){
            running[id]=false;
            autobetState[id].isWaiting = false; // Reset waiting if manually stopped
            send(id,"🛑 Stopped.");
        }
        if(txt==="📊 Stats") showStats(id,id);
        if(txt==="💰 Profit") profitReport(id,id);
        if(txt==="📩 Contact") send(id,"Support: "+ADMIN_HANDLE);
        if(txt==="🔑 My Token") send(id,"Your Token:\n`"+getToken(id)+"`",{parse_mode:"Markdown"});
        if(txt.startsWith("/activate ")){
            const res=activateKey(id,txt.split(" ")[1]||"");
            send(id,res.msg || (res.ok?"✅ Activated! Expires: "+res.expiry:"Error"));
        }
        if(txt.startsWith("/setcreds ")){
            const parts=txt.split(" ");
            if(parts.length<3)return send(id,"Usage: /setcreds PHONE PASSWORD");
            userCreds[id]={phone:parts[1],pass:parts[2]};
            send(id,"✅ Credentials saved! Attempting login...");
            robustLogin(id,id);
        }

        // --- AUTOBET HANDLERS ---
        if(txt==="🤖 AutoBet Setup") return send(id,"🤖 AutoBet Configuration",{reply_markup:autobetMenu});
        if(txt==="🔙 Back") return send(id,"Main Menu",{reply_markup:userMenu(id)});
        if(txt==="✅ Enable AutoBet"){autobetCfg[id].enabled=true;return send(id,"✅ AutoBet Enabled.");}
        if(txt==="❌ Disable AutoBet"){autobetCfg[id].enabled=false;return send(id,"❌ AutoBet Disabled.");}
        if(txt==="👀 Watch Mode ON"){autobetCfg[id].watch=true;return send(id,"👀 Watch Mode ON.");}
        if(txt==="👀 Watch Mode OFF"){autobetCfg[id].watch=false;return send(id,"👀 Watch Mode OFF.");}
        if(txt==="📊 AutoBet Status") return autobetStatus(id,id);

        if(txt==="💰 Set Base Bet"){userAction[id]="SET_BASE";return send(id,"Enter base bet amount (e.g. 1):");}
        if(txt==="📈 Set Max Level"){userAction[id]="SET_MAX";return send(id,"Enter max level (1-10):");}
        if(txt==="🔢 Set Watch Losses"){userAction[id]="SET_WATCH_L";return send(id,"Enter watch losses (e.g. 5):");}
        if(txt==="📝 Set Custom Bets"){userAction[id]="SET_CUSTOM";return send(id,"Enter custom bets (e.g. 1,3,10,30,90):");}
        if(txt==="🎯 Set Profit Target"){userAction[id]="SET_TARGET";return send(id,"Enter target profit (e.g. 1000):");}
        if(txt==="⏳ Set Section Delay"){userAction[id]="SET_DELAY";return send(id,"Enter restart delay in hours (e.g. 1):");}

        if(userAction[id]==="SET_BASE"){
            const v=parseFloat(txt);if(isNaN(v))return send(id,"Invalid number.");
            autobetCfg[id].baseBet=v;userAction[id]=null;
            return send(id,"✅ Base bet set to ₹"+v);
        }
        if(userAction[id]==="SET_MAX"){
            const v=parseInt(txt);if(isNaN(v)||v<1||v>10)return send(id,"Invalid level.");
            autobetCfg[id].maxLvl=v;userAction[id]=null;
            return send(id,"✅ Max level set to "+v);
        }
        if(userAction[id]==="SET_WATCH_L"){
            const v=parseInt(txt);if(isNaN(v))return send(id,"Invalid number.");
            autobetCfg[id].watchLoss=v;userAction[id]=null;
            return send(id,"✅ Watch losses set to "+v);
        }
        if(userAction[id]==="SET_CUSTOM"){
            const v=txt.split(",").map(x=>parseFloat(x.trim()));
            if(v.some(isNaN))return send(id,"Invalid list.");
            autobetCfg[id].customBets=v;userAction[id]=null;
            return send(id,"✅ Custom bets updated.");
        }
        if(userAction[id]==="SET_TARGET"){
            const v=parseFloat(txt);if(isNaN(v))return send(id,"Invalid number.");
            autobetCfg[id].targetProfit=v;userAction[id]=null;
            return send(id,"✅ Profit target set to ₹"+v);
        }
        if(userAction[id]==="SET_DELAY"){
            const v=parseFloat(txt);if(isNaN(v))return send(id,"Invalid number.");
            autobetCfg[id].restartDelay=v;userAction[id]=null;
            return send(id,"✅ Section delay set to "+v+" hour(s)");
        }
    });
}

startBot();
