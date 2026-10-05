const TelegramBot = require('node-telegram-bot-api');
const axios       = require('axios');
const crypto      = require('crypto');
const zlib        = require('zlib');
const puppeteer   = require('puppeteer');
const fs          = require('fs');
const path        = require('path');
const { PNG }      = require('pngjs');
// ============================================================
//  HELPER FUNCTIONS
// ============================================================

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ============================================================
//  CAPTCHA IMAGE EXTRACTION
// ============================================================

async function extractCaptchaImages(page) {
    const imageData = await page.evaluate(() => {
        const bgImg = document.querySelector('.captcha_background');
        const sliderImg = document.querySelector('.captcha_slider');
        
        if (!bgImg || !sliderImg) return null;
        
        const bgContainer = bgImg.parentElement;
        const bgRect = bgContainer ? bgContainer.getBoundingClientRect() : bgImg.getBoundingClientRect();
        const sliderRect = sliderImg.getBoundingClientRect();
        
        return {
            bgSrc: bgImg.src,
            sliderSrc: sliderImg.src,
            displayWidth: bgRect.width,
            displayHeight: bgRect.height,
            sliderDisplayLeft: sliderRect.left,
            sliderDisplayTop: sliderRect.top,
        };
    });
    
    if (!imageData || !imageData.bgSrc || !imageData.sliderSrc) {
        return null;
    }
    
    let bgData, pieceData;
    
    try {
        const bgResponse = await axios.get(imageData.bgSrc, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': SITE_URL,
                'Origin': SITE_URL
            }
        });
        const bgPng = PNG.sync.read(Buffer.from(bgResponse.data));
        bgData = { width: bgPng.width, height: bgPng.height, data: bgPng.data };
        
        const pieceResponse = await axios.get(imageData.sliderSrc, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': SITE_URL,
                'Origin': SITE_URL
            }
        });
        const piecePng = PNG.sync.read(Buffer.from(pieceResponse.data));
        pieceData = { width: piecePng.width, height: piecePng.height, data: piecePng.data };
    } catch (err) {
        console.error('[CAPTCHA] Failed to download images via axios:', err.message);
        
        try {
            const bgBase64 = await page.evaluate((src) => {
                return new Promise((resolve) => {
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        canvas.getContext('2d').drawImage(img, 0, 0);
                        resolve(canvas.toDataURL('image/png').split(',')[1]);
                    };
                    img.onerror = () => resolve(null);
                    img.src = src;
                });
            }, imageData.bgSrc);
            
            const pieceBase64 = await page.evaluate((src) => {
                return new Promise((resolve) => {
                    const img = new Image();
                    img.onload = () => {
                        const canvas = document.createElement('canvas');
                        canvas.width = img.width;
                        canvas.height = img.height;
                        canvas.getContext('2d').drawImage(img, 0, 0);
                        resolve(canvas.toDataURL('image/png').split(',')[1]);
                    };
                    img.onerror = () => resolve(null);
                    img.src = src;
                });
            }, imageData.sliderSrc);
            
            if (bgBase64 && pieceBase64) {
                const bgPng = PNG.sync.read(Buffer.from(bgBase64, 'base64'));
                bgData = { width: bgPng.width, height: bgPng.height, data: bgPng.data };
                const piecePng = PNG.sync.read(Buffer.from(pieceBase64, 'base64'));
                pieceData = { width: piecePng.width, height: piecePng.height, data: piecePng.data };
            }
        } catch (err2) {
            console.error('[CAPTCHA] Fallback also failed:', err2.message);
            return null;
        }
    }
    
    return {
        bgData,
        pieceData,
        displayWidth: imageData.displayWidth,
        displayHeight: imageData.displayHeight,
    };
}

// ============================================================
//  GAP DETECTION (Template Matching)
// ============================================================

function solveGapPosition(bgData, pieceData, displayWidth, displayHeight) {
    const { width: bgW, height: bgH, data: bgPixels } = bgData;
    const { width: pieceW, height: pieceH, data: piecePixels } = pieceData;
    
    const scaleX = displayWidth / bgW;
    
    const pieceOpaquePixels = [];
    let contentMinX = pieceW, contentMaxX = 0;
    let contentMinY = pieceH, contentMaxY = 0;
    
    for (let y = 0; y < pieceH; y++) {
        for (let x = 0; x < pieceW; x++) {
            const idx = (y * pieceW + x) * 4;
            const alpha = piecePixels[idx + 3];
            if (alpha > 80) {
                pieceOpaquePixels.push({
                    x, y,
                    r: piecePixels[idx] / 255,
                    g: piecePixels[idx + 1] / 255,
                    b: piecePixels[idx + 2] / 255,
                });
                contentMinX = Math.min(contentMinX, x);
                contentMaxX = Math.max(contentMaxX, x);
                contentMinY = Math.min(contentMinY, y);
                contentMaxY = Math.max(contentMaxY, y);
            }
        }
    }
    
    if (pieceOpaquePixels.length < 50) return -1;
    
    const bgR = new Float32Array(bgW * bgH);
    const bgG = new Float32Array(bgW * bgH);
    const bgB = new Float32Array(bgW * bgH);
    
    for (let i = 0; i < bgW * bgH; i++) {
        bgR[i] = bgPixels[i * 4] / 255;
        bgG[i] = bgPixels[i * 4 + 1] / 255;
        bgB[i] = bgPixels[i * 4 + 2] / 255;
    }
    
    let bestX = 0;
    let bestScore = Infinity;
    
    for (let x = 0; x <= bgW - pieceW; x += 2) {
        let totalDiff = 0;
        let count = 0;
        
        for (const pp of pieceOpaquePixels) {
            const bgX = x + pp.x;
            const bgY = pp.y;
            
            if (bgX >= 0 && bgX < bgW && bgY >= 0 && bgY < bgH) {
                const bgIdx = bgY * bgW + bgX;
                const dr = bgR[bgIdx] - pp.r;
                const dg = bgG[bgIdx] - pp.g;
                const db = bgB[bgIdx] - pp.b;
                totalDiff += Math.sqrt(dr * dr + dg * dg + db * db);
                count++;
            }
        }
        
        if (count > 0) {
            const avgDiff = totalDiff / count;
            if (avgDiff < bestScore) {
                bestScore = avgDiff;
                bestX = x;
            }
        }
    }
    
    const refineMin = Math.max(0, bestX - 15);
    const refineMax = Math.min(bgW - pieceW, bestX + 15);
    
    for (let x = refineMin; x <= refineMax; x++) {
        let totalDiff = 0;
        let count = 0;
        
        for (const pp of pieceOpaquePixels) {
            const bgX = x + pp.x;
            const bgY = pp.y;
            
            if (bgX >= 0 && bgX < bgW && bgY >= 0 && bgY < bgH) {
                const bgIdx = bgY * bgW + bgX;
                const dr = bgR[bgIdx] - pp.r;
                const dg = bgG[bgIdx] - pp.g;
                const db = bgB[bgIdx] - pp.b;
                totalDiff += Math.sqrt(dr * dr + dg * dg + db * db);
                count++;
            }
        }
        
        if (count > 0) {
            const avgDiff = totalDiff / count;
            if (avgDiff < bestScore) {
                bestScore = avgDiff;
                bestX = x;
            }
        }
    }
    
    const dragDistance = Math.round(bestX * scaleX);
    return dragDistance;
}

// ============================================================
//  HUMAN-LIKE DRAG SIMULATION
// ============================================================

async function performHumanDrag(page, dragDistance) {
    const handlerPos = await page.evaluate(() => {
        const handler = document.querySelector('.captcha_handler');
        if (!handler) return null;
        const rect = handler.getBoundingClientRect();
        return {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
        };
    });
    
    if (!handlerPos) return false;
    
    const startX = handlerPos.x;
    const startY = handlerPos.y;
    const totalSteps = randomInt(50, 80);
    
    await page.mouse.move(startX, startY);
    await sleep(randomInt(200, 500));
    
    const dragResult = await page.evaluate(({ dragDistance, totalSteps }) => {
        return new Promise((resolve) => {
            const handler = document.querySelector('.captcha_handler');
            if (!handler) {
                resolve({ success: false, error: 'handler not found' });
                return;
            }
            
            const rect = handler.getBoundingClientRect();
            const cx = rect.x + rect.width / 2;
            const cy = rect.y + rect.height / 2;
            const endX = cx + dragDistance;
            
            const points = [];
            const jitter = (min, max) => min + Math.random() * (max - min);
            
            for (let i = 1; i <= totalSteps; i++) {
                const progress = i / totalSteps;
                let eased;
                
                if (progress < 0.05) {
                    eased = Math.pow(progress / 0.05, 2) * 0.05;
                } else if (progress < 0.2) {
                    const p = (progress - 0.05) / 0.15;
                    eased = 0.05 + p * p * 0.2;
                } else if (progress < 0.65) {
                    eased = 0.25 + ((progress - 0.2) / 0.45) * 0.4;
                } else if (progress < 0.85) {
                    const p = (progress - 0.65) / 0.20;
                    eased = 0.65 + (1 - Math.pow(1 - p, 2)) * 0.2;
                } else {
                    const p = (progress - 0.85) / 0.15;
                    eased = 0.85 + Math.pow(p, 2) * 0.15;
                }
                
                const px = cx + dragDistance * eased;
                const py = cy + jitter(-3, 3);
                points.push({ x: px, y: py, progress });
            }
            
            let pointIndex = 0;
            const dispatchNext = () => {
                if (pointIndex >= points.length) {
                    setTimeout(() => {
                        const upEvent = new PointerEvent('pointerup', {
                            bubbles: true, cancelable: true,
                            clientX: endX, clientY: cy, screenX: endX, screenY: cy,
                            pointerId: 1, pointerType: 'mouse'
                        });
                        handler.dispatchEvent(upEvent);
                        
                        const mouseUpEvent = new MouseEvent('mouseup', {
                            bubbles: true, cancelable: true, clientX: endX, clientY: cy
                        });
                        document.dispatchEvent(mouseUpEvent);
                        
                        setTimeout(() => resolve({ success: true }), 500);
                    }, 200);
                    return;
                }
                
                const point = points[pointIndex];
                let delay = 5 + Math.random() * 10;
                
                setTimeout(() => {
                    const moveEvent = new MouseEvent('mousemove', {
                        bubbles: true, cancelable: true,
                        clientX: point.x, clientY: point.y
                    });
                    document.dispatchEvent(moveEvent);
                    
                    pointIndex++;
                    dispatchNext();
                }, delay);
            };
            
            const downEvent = new PointerEvent('pointerdown', {
                bubbles: true, cancelable: true,
                clientX: cx, clientY: cy, screenX: cx, screenY: cy,
                pointerId: 1, pointerType: 'mouse'
            });
            handler.dispatchEvent(downEvent);
            
            const mouseDownEvent = new MouseEvent('mousedown', {
                bubbles: true, cancelable: true, clientX: cx, clientY: cy
            });
            handler.dispatchEvent(mouseDownEvent);
            
            setTimeout(() => dispatchNext(), 100);
        });
    }, { dragDistance, totalSteps });
    
    return dragResult.success;
}

async function isCaptchaVisible(page) {
    return await page.evaluate(() => {
        const bg = document.querySelector('.captcha_background');
        const slider = document.querySelector('.captcha_slider');
        if (!bg || !slider) return false;
        
        const overlay = document.querySelector('.van-overlay');
        if (overlay) {
            const style = window.getComputedStyle(overlay);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        
        return true;
    });
}

async function solveCaptcha(page) {
    const images = await extractCaptchaImages(page);
    if (!images) return -1;
    return solveGapPosition(images.bgData, images.pieceData, images.displayWidth, images.displayHeight);
}

// ============================================================
//  COMPLETE LOGIN WITH DIRECT URL NAVIGATION TO WINGO 1M
// ============================================================

async function captchaLogin(userId, chatId, phone, password, bot, logBoth) {
    console.log(`[LOGIN] Starting captcha login for user ${userId}...`);
  
    let browser;
    let page;
    
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--single-process',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1280,800'
            ]
        });

        page = await browser.newPage();
        await browser.defaultBrowserContext().overridePermissions(SITE_URL, ['notifications']);
        await page.setDefaultNavigationTimeout(90000);
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        let capturedToken = null;
        let resolveGetBalanceToken;
        const getBalanceTokenPromise = new Promise((resolve) => {
            resolveGetBalanceToken = resolve;
        });

        const captureToken = (rawToken, source) => {
            const token = normalizeToken(rawToken);
            if (token.length < 20 || capturedToken) return false;
            capturedToken = token;
            resolveGetBalanceToken(token);
            console.log(`[LOGIN] ✅ Token captured from ${source}! length=${token.length}`);
            return true;
        };

        // Capture the token wherever the current site places it: authenticated API
        // request headers, response headers, or login response JSON.
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            try {
                const headers = req.headers();
                const authHeader = headers['authorization'] || headers['Authorization'];
                if (authHeader && /api|GetBalance|Login/i.test(req.url())) captureToken(authHeader, 'API request');
            } catch (err) {
                console.error('[LOGIN] Request interception error:', err.message);
            }
            req.continue().catch(() => {});
        });
        page.on('response', async (response) => {
            if (capturedToken || !/Login|GetBalance|api/i.test(response.url())) return;
            try {
                const headers = response.headers();
                if (captureToken(headers.authorization || headers['x-auth-token'], 'API response header')) return;
                const contentType = String(headers['content-type'] || '').toLowerCase();
                if (contentType.includes('application/json')) {
                    const body = await response.json().catch(() => null);
                    captureToken(body, 'API response JSON');
                }
            } catch (err) {
                console.warn('[LOGIN] API response token inspection failed:', err.message);
            }
        });
        
        // Navigate to login page
        // The site keeps long-running resources open, so navigation may time out
        // even after the login form is usable. The visible form is the readiness check.
        try {
            await page.goto(LOGIN_PAGE_URL, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
        } catch (navigationError) {
            console.warn(`[LOGIN] Navigation still loading; checking form: ${navigationError.message}`);
        }

        try {
            await page.waitForSelector('input', { timeout: 10000, visible: true });
        } catch (_) {
            // /login currently opens the home shell first; activate its navigation login panel.
            const opened = await page.evaluate(() => {
                const control = [...document.querySelectorAll('.nav-btn,button,[role="button"]')]
                    .find(element => /^log\s*in$/i.test((element.innerText || '').trim()));
                if (!control) return false;
                control.click();
                return true;
            });
            if (!opened) throw new Error('Login control not found on site');
            await page.waitForSelector('input', { timeout: 30000, visible: true });
        }
        await sleep(1000);

        const visibleInputs = await page.$$('input');
        const isVisible = async (handle) => {
            try {
                return await handle.evaluate(el => {
                    const s = getComputedStyle(el);
                    const r = el.getBoundingClientRect();
                    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
                });
            } catch (_) {
                return false;
            }
        };

        const candidates = [];
        for (const handle of visibleInputs) {
            if (await isVisible(handle)) candidates.push(handle);
        }

        const candidateMeta = [];
        for (const handle of candidates) {
            const meta = await handle.evaluate(el => ({
                type: String(el.getAttribute('type') || '').toLowerCase(),
                name: String(el.getAttribute('name') || '').toLowerCase(),
                placeholder: String(el.getAttribute('placeholder') || '').toLowerCase()
            }));
            candidateMeta.push({ handle, ...meta });
        }

        const safePhone = candidateMeta.find(item =>
            item.type !== 'password' &&
            /phone|mobile|number|username|account/.test(`${item.name} ${item.placeholder}`)
        ) || candidateMeta.find(item => item.type !== 'password');
        
        const safePhoneInput = safePhone?.handle;
        if (!safePhoneInput) throw new Error('Phone input not found');
        
        await safePhoneInput.click({ clickCount: 3 });
        await safePhoneInput.press('Backspace');
        await safePhoneInput.type(String(phone), { delay: 50 });

        await sleep(500);

        const passwordInput = candidateMeta.find(item => item.type === 'password')?.handle ||
            candidateMeta.find(item => item.handle !== safePhoneInput)?.handle;
            
        if (!passwordInput) throw new Error('Password input not found');
        
        await passwordInput.click({ clickCount: 3 });
        await passwordInput.press('Backspace');
        await passwordInput.type(String(password), { delay: 50 });
        
        // Click Login button
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button'));
            const loginBtn = btns.find(b => b.innerText.includes('Log in') || b.innerText.includes('Login'));
            if (loginBtn) loginBtn.click();
            else document.querySelector('form')?.submit();
        });
        
        await sleep(2000);
        
        let captchaDetected = false;
        for (let i = 0; i < 20; i++) {
            captchaDetected = await isCaptchaVisible(page);
            if (captchaDetected) break;
            await sleep(500);
        }
        
        if (captchaDetected) {
            console.log('[LOGIN] Captcha detected! Solving...');
            const dragDistance = await solveCaptcha(page);
            
            if (dragDistance < 10 || dragDistance > 330) {
                if (chatId) await logBoth(chatId, '❌ Captcha solve failed - invalid distance');
                return false;
            }
            
            const dragged = await performHumanDrag(page, dragDistance);
            if (!dragged) {
                if (chatId) await logBoth(chatId, '❌ Captcha solve failed - drag error');
                return false;
            }
            
            await sleep(3000);
            if (await isCaptchaVisible(page)) {
                if (chatId) await logBoth(chatId, '❌ Captcha solve failed - server rejected');
                return false;
            }
            console.log('[LOGIN] ✅ Captcha solved successfully!');
        }
        
        // === REDIRECT TO WINGO PAGE TO TRIGGER GETBALANCE ===
        try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 });
        } catch (e) {}
        await sleep(3000);
        
        console.log('[LOGIN] Navigating to WinGo 1M page to trigger GetBalance request...');
        console.log('[LOGIN] Navigating directly to WinGo 1M page via URL...');
        try {
            await page.goto(SITE_URL + '/WinGo/WinGo_30S', {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
        } catch (navigationError) {
            console.warn(`[LOGIN] WinGo page still loading; checking captured token: ${navigationError.message}`);
        }
        await sleep(3000);

        const displayedBalance = await page.evaluate(() => {
            const amountPattern = /(?:₹|Rs\.?|INR)\s*([\d,]+(?:\.\d+)?)/i;
            const labels = [...document.querySelectorAll('*')]
                .filter(element => element.children.length === 0 && /wallet\s*balance/i.test(element.textContent || ''));

            for (const label of labels) {
                let parent = label;
                for (let depth = 0; depth < 4 && parent; depth++, parent = parent.parentElement) {
                    const match = (parent.innerText || '').match(amountPattern);
                    if (match) return Number(match[1].replace(/,/g, ''));
                }
            }

            const match = (document.body.innerText || '').match(amountPattern);
            return match ? Number(match[1].replace(/,/g, '')) : null;
        }).catch(() => null);

        if (Number.isFinite(displayedBalance)) {
            balanceFallbacks[String(userId)] = { balance: displayedBalance, capturedAt: Date.now() };
            console.log(`[BALANCE FALLBACK] Wallet page balance captured for user ${userId}: ${displayedBalance}`);
        }

        const cookies = await page.cookies().catch(() => []);
        userSessions[String(userId)] = {
            cookieHeader: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
            capturedAt: Date.now()
        };
        
        // Wait specifically for the authenticated GetBalance request if not captured yet.
        if (!capturedToken) {
            console.log('[LOGIN] Waiting for GetBalance token promise...');
            await Promise.race([
                getBalanceTokenPromise,
                new Promise((resolve) => setTimeout(resolve, 15000))
            ]);
        }

        if (capturedToken) {
            console.log(`[LOGIN] ✅ Token captured and returned directly to bot.js (length=${capturedToken.length})`);
            if (chatId) await logBoth(chatId, `✅ [SUCCESS] Token captured for user ${userId}!`);
            return capturedToken;
        } else {
            console.error('[LOGIN] ❌ Token not found');
            if (chatId) await logBoth(chatId, `❌ Login failed - token not captured for user ${userId}`, true);
            return false;
        }
        
    } catch (err) {
        console.error(`[LOGIN] Error: ${err.message}`);
        if (chatId) await logBoth(chatId, `❌ Login Error for user ${userId}: ${err.message}`, true);
        return false;
    } finally {
        if (browser) await browser.close();
    }
}

// ============================================================
//  CONFIG
// ============================================================
// Keep secrets outside the source code.
const BOT_TOKEN    = process.env.BOT_TOKEN || "8856615469:AAHs5rN-COYbdDkFhf0LSOKutLfGo89qrOw";
const OWNER_ID     = 8869874751;
const OWNER_PASS   = process.env.OWNER_PASS || "2004";
const ADMIN_HANDLE = "@Sivakutty1";
const REG_LINK     = "https://www.ts777.co";
const WIN_STICKER  = "CAACAgUAAxkBAAFHUGNp4JX1-ohP4uBEWpfNptaz-HmwVgAC4hgAAhboKVbObuGuTcMs2zsE";
const LOSS_STICKER = "CAACAgUAAxkBAAFHUGVp4JX-BE2TRkhIKTwcjkwW-gzdPAACthoAAoG8YVYiydObSa0O8zsE";

const BET_URL     = "https://api.ar-lottery01.com/api/Lottery/WinGoBet";
const LOGIN_URL   = "https://api.tashanrfv.com/api/webapi/Login";
const CAPTCHA_URL = "https://13llottery.com/api/Home/Captcha";
const API_URL     = "https://luciferapi.com/30sec.php";
const DRAW_URL    = "https://luciferapi.com/30sec.php";
// Lucifer currently exposes the verified legacy history endpoint as 30sec.php;
// no working 1min.php/1m.php endpoint was found, so it is used only as a
// secondary historical cross-check, never as the primary 1M result source.
const LUCIFER_OLD_ANALYSIS_URL = "https://luciferapi.com/30sec.php";
const COMBINED_PAGE_URL = "https://endearing-bavarois-067272.netlify.app/";
// BigSmall+Number uses the requested one-minute draw source.
const COMBINED_SOURCE_URL = "https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json";
// Authoritative 1-minute source used by uploaded 3.html.
const WHIMSICAL_SOURCE_URL = "https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json";
// Lucifer root returns the complete historical dataset used for shared number ranking.
const LUCIFER_FULL_HISTORY_URL = "https://luciferapi.com/";
const SITE_URL    = "https://www.ts777.co";
const LOGIN_PAGE_URL = "https://www.ts777.co/login";
const CHROME_ARGS = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--disable-extensions', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--no-first-run',
    '--no-zygote', '--single-process'
];

// Martingale multipliers — user can customize base bet
const MULT = [1, 3, 9, 27, 81, 243, 729, 2187, 6561, 19683]; // Standard 3x Martingale multipliers
const SIZE_WIN_MULTIPLIER = 1.98;   // Gross return for a BIG/SMALL win
const NUMBER_WIN_MULTIPLIER = 8;    // Gross return for an exact-number win

// ============================================================
//  RENDER KEEP-ALIVE
// ============================================================
const http = require('http');
const requestedPort = Number(process.env.PORT) || 5000;
const keepAliveServer = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('SIVA BOT OK');
});
function listenKeepAlive(port) {
    keepAliveServer.once('error', error => {
        if (error.code === 'EADDRINUSE') {
            console.warn(`[HTTP] Port ${port} is busy; trying ${port + 1}`);
            listenKeepAlive(port + 1);
            return;
        }
        console.error('[HTTP] Keep-alive server error:', error.message);
    });
    keepAliveServer.listen(port, () => console.log(`✅ Keep-alive server on port ${port}`));
}
listenKeepAlive(requestedPort);

const RENDER_URL = process.env.RENDER_URL || "";
if (RENDER_URL) {
    setInterval(() => {
        axios.get(RENDER_URL).catch(() => {});
        console.log("[PING] Keep-alive ping sent");
    }, 14 * 60 * 1000).unref?.();
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
let userCreds       = {};
let credsSetupState = {};
let loginRetryTimers = {};
let autobetCfg      = {};
let autobetState   = {};
let profitTrack    = {};
let GLOBAL_TOKEN   = "";
// Tokens are intentionally kept only in bot.js memory. No token file is created.
// A Render restart/redeploy requires login again, which is expected for this design.

function normalizeToken(value, seen = new Set()) {
    if (value == null) return "";
    if (typeof value === "string") {
        const raw = value.replace(/^Bearer\s+/i, '').replace(/^['\"]|['\"]$/g, '').trim();
        if (!raw || /[{}]/.test(raw)) return "";
        return raw;
    }
    if (typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);
    const preferred = ["token", "accessToken", "access_token", "jwt", "id_token", "authorization"];
    for (const key of preferred) {
        const found = normalizeToken(value[key], seen);
        if (found) return found;
    }
    for (const child of Object.values(value)) {
        const found = normalizeToken(child, seen);
        if (found) return found;
    }
    return "";
}

function saveUserToken(userId, value) {
    const key = String(userId);
    const token = normalizeToken(value);
    if (!token || token.length < 20) {
        console.error(`[TOKEN SAVE FAILED] user=${key}; invalid token`);
        return false;
    }

    // Keep one canonical value, while mirroring it to the legacy credential object.
    // This prevents login success followed by a missing token when callers use different stores.
    userTokens[key] = token;
    if (!userCreds[key]) userCreds[key] = {};
    userCreds[key].token = token;

    const cached = normalizeToken(userTokens[key]);
    const mirrored = normalizeToken(userCreds[key].token);
    const ok = cached === token && mirrored === token;
    console.log(`[TOKEN ${ok ? 'SAVED' : 'SAVE FAILED'}] user=${key}; length=${token.length}; cache=${ok ? 'ready' : 'missing'}`);
    return ok;
}

// Shared token setter used by both manual /setmytoken and automatic login.
function applyMyToken(userId, rawToken) {
    const id = String(userId);
    const cleanToken = normalizeToken(rawToken);

    if (!cleanToken || cleanToken.length < 20) {
        console.error(`[SETMYTOKEN FAILED] user=${id}; invalid token`);
        return { ok: false, token: "", reason: "Token too short or invalid" };
    }

    const saved = saveUserToken(id, cleanToken);
    const verified = getToken(id) === cleanToken;

    if (!saved || !verified) {
        console.error(`[SETMYTOKEN FAILED] user=${id}; cache verification failed`);
        return { ok: false, token: cleanToken, reason: "Token cache verification failed" };
    }

    console.log(`[SETMYTOKEN AUTO] user=${id}; token saved automatically`);
    return { ok: true, token: cleanToken };
}

function clearUserToken(userId) {
    const key = String(userId);
    delete userTokens[key];
    delete userSessions[key];
    delete balanceFallbacks[key];
    if (userCreds[key]) delete userCreds[key].token;
    return true;
}

// Relogin only for an explicit authentication/token-expiry response.
// Normal bet errors must never clear a valid token.
function isTokenExpiredMessage(message) {
    const text = String(message || '').toLowerCase().trim();
    return /(?:token|access token|jwt)\s+(?:is\s+)?(?:expired|invalid|illegal|missing|required)|(?:invalid|expired|missing|required)\s+(?:access\s+)?token|no token|unauthori[sz]ed|authentication\s+failed|login\s+required/.test(text);
}

let userTokens = {}; // Runtime-only token cache; deliberately not persisted to a file.
let userSessions = {}; // Runtime-only cookies/device metadata for authenticated API calls.
let balanceFallbacks = {}; // Short-lived wallet values read from the authenticated page.
let userLastSeen = {};
const nextRunTimers = new Map();
const resultCheckTimers = new Map();
const resultCheckInFlight = new Set();
// Prevent duplicate result callbacks from sending a second WIN/LOSS box or sticker.
const settledPeriods = new Map();
// One prediction/bet dispatch per user and period, even if multiple timers fire.
const predictionDispatches = new Map();
const runInFlight = new Set();
const loginInFlight = new Map();
const MAX_SENT_PERIODS = 6;
const MAX_KEYS = 5000;
const USER_IDLE_TTL_MS = 60 * 60 * 1000;

function clearUserTimers(userId) {
    const key = String(userId);
    const nextTimer = nextRunTimers.get(key);
    if (nextTimer) clearTimeout(nextTimer);
    nextRunTimers.delete(key);

    const resultTimer = resultCheckTimers.get(key);
    if (resultTimer) clearTimeout(resultTimer);
    resultCheckTimers.delete(key);
    resultCheckInFlight.delete(key);
    settledPeriods.delete(key);
    predictionDispatches.delete(key);
    runInFlight.delete(key);
}

function cleanupUserResources(userId, removeAccess = false) {
    const key = String(userId);
    clearUserTimers(key);
    resultCheckInFlight.delete(key);
    runInFlight.delete(key);
    delete adminState[key];
    delete userAction[key];
    delete userCreds[key];
    delete credsSetupState[key];
    delete loginRetryTimers[key];
    delete userTokens[key];
    delete userSessions[key];
    delete userLastSeen[key];
    delete stats[key];
    delete userStates[key];
    delete autobetCfg[key];
    delete autobetState[key];
    delete profitTrack[key];
    delete sentPeriods[key];
    delete running[key];
    if (removeAccess) delete usersAccess[key];
}

function pruneExpiredUsers() {
    const now = Date.now();
    const tracked = new Set([
        ...Object.keys(usersAccess),
        ...Object.keys(userLastSeen),
        ...Object.keys(stats),
        ...Object.keys(userStates),
        ...Object.keys(autobetCfg),
        ...Object.keys(autobetState),
        ...Object.keys(profitTrack)
    ]);
    for (const key of tracked) {
        const expired = usersAccess[key] && Number(usersAccess[key]) <= now;
        const idle = !running[key] && !hasAccess(key) &&
            now - Number(userLastSeen[key] || 0) > USER_IDLE_TTL_MS;
        if (!running[key] && (expired || idle)) cleanupUserResources(key, true);
    }
}

// Prevent abandoned user objects and expired access records from accumulating.
const userPruneTimer = setInterval(pruneExpiredUsers, 10 * 60 * 1000);
userPruneTimer.unref?.();

function scheduleRun(userId, chatId, delayMs) {
    const key = String(userId);
    if (!running[userId]) return;
    const oldTimer = nextRunTimers.get(key);
    if (oldTimer) clearTimeout(oldTimer);
    const safeDelay = Math.max(1000, Number(delayMs) || 10000);
    const timer = setTimeout(() => {
        nextRunTimers.delete(key);
        if (running[userId]) {
            runPredict(userId, chatId).catch(error => {
                console.error("[RUN PREDICT ERROR]", error?.message || error);
                if (running[userId]) scheduleRun(userId, chatId, 10000);
            });
        }
    }, safeDelay);
    if (typeof timer.unref === "function") timer.unref();
    nextRunTimers.set(key, timer);
}
const MAX_LEVEL_HISTORY = 10;
let consecutiveSkipRemaining = 0;
let consecutiveSkipTriggerKey = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchList() {
    try {
        const response = await axios.get(DRAW_URL + "?_=" + Date.now(), {
            headers: {
                "Accept": "application/json",
                "Origin": SITE_URL,
                "Referer": SITE_URL,
                "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36"
            },
            timeout: 10000,
            validateStatus: status => status >= 200 && status < 300
        });
        const json = response.data;
        const rawList = Array.isArray(json) ? json :
            Array.isArray(json?.data) ? json.data :
            Array.isArray(json?.data?.list) ? json.data.list :
            Array.isArray(json?.results) ? json.results :
            Array.isArray(json?.records) ? json.records :
            Array.isArray(json?.result?.list) ? json.result.list : [];

        if (!rawList.length) {
            console.error("[FETCH LIST ERROR] Lucifer API response was not a list");
            return null;
        }

        return rawList.map((item, index) => {
            if (typeof item === "string" || typeof item === "number") {
                return { number: String(item).replace(/\D/g, "").slice(-1), issueNumber: String(index) };
            }

            const number = item?.number ?? item?.result ?? item?.resultNumber ??
                item?.num ?? item?.value ?? item?.openNumber ?? item?.winNumber ?? item?.openNum;
            const issueNumber = item?.issue ?? item?.issueNumber ?? item?.period ??
                item?.periodNumber ?? item?.expect ?? item?.id ?? index;

            return {
                ...item,
                number: String(number ?? "").replace(/\D/g, "").slice(-1),
                issueNumber: String(issueNumber)
            };
        }).filter(item => /^[0-9]$/.test(item.number)).sort((a, b) => {
            const ai = String(a.issueNumber);
            const bi = String(b.issueNumber);
            if (/^\d+$/.test(ai) && /^\d+$/.test(bi)) {
                if (ai.length !== bi.length) return bi.length - ai.length;
                return bi.localeCompare(ai);
            }
            return 0;
        });
    } catch (error) {
        console.error("[FETCH LIST ERROR]", error.message);
    }

    try {
        const fallbackResponse = await axios.get("https://gorgeous-maamoul-72bc10.netlify.app/", {
            timeout: 15000,
            headers: {
                "Accept": "text/html,application/xhtml+xml",
                "User-Agent": "Mozilla/5.0"
            }
        });

        const html = String(fallbackResponse?.data || "");
        const issueMatch = html.match(/Issue\s+(\d+)\s+·\s+Active prediction/i) || html.match(/Issue\s+(\d+)/i);
        const lastResultMatch = html.match(/CURRENT LAST RESULT\s+(\d+)\s*\(([A-Z]+)\)/i);
        const historyMatches = [...html.matchAll(/R\d+\s*[^\d]*(\d+)(?:\s*(?:SMALL|BIG))?/gi)];

        const fallbackList = [];
        if (issueMatch && lastResultMatch) {
            fallbackList.push({
                issueNumber: issueMatch[1],
                number: lastResultMatch[1]
            });
        }

        const history = historyMatches
            .map(match => match[1])
            .filter((value, index, arr) => value && arr.indexOf(value) === index)
            .slice(0, 10)
            .map((value, index) => ({
                issueNumber: String(Date.now() + index),
                number: value
            }));

        if (fallbackList.length) {
            const merged = [...history, ...fallbackList].filter(item => /^[0-9]$/.test(String(item.number).replace(/\D/g, ""))).slice(0, 8);
            if (merged.length) return merged.sort((a, b) => String(b.issueNumber).localeCompare(String(a.issueNumber)));
        }

        if (history.length) return history.slice(0, 8);
        console.error("[FETCH LIST ERROR] Public prediction page fallback did not contain a valid latest result");
        return null;
    } catch (fallbackError) {
        console.error("[FETCH LIST ERROR] Fallback source also failed:", fallbackError.message);
        return null;
    }
}

// The user-provided Netlify page uses this JSON source directly.  Keep this
// request bounded and return only a small normalized list to avoid retaining
// large response objects in the Render free-plan process.
async function fetchCombinedSourceList() {
    try {
        const response = await axios.get(COMBINED_SOURCE_URL + "?_=" + Date.now(), {
            headers: {
                "Accept": "application/json",
                "Cache-Control": "no-cache, no-store, max-age=0",
                "Pragma": "no-cache",
                "Origin": COMBINED_PAGE_URL.replace(/\/$/, ""),
                "Referer": COMBINED_PAGE_URL,
                "User-Agent": "Mozilla/5.0"
            },
            timeout: 8000,
            maxContentLength: 512 * 1024,
            maxBodyLength: 512 * 1024,
            validateStatus: status => status >= 200 && status < 300
        });
        const raw = Array.isArray(response.data?.data?.list) ? response.data.data.list : [];
        return raw.slice(0, 25).map(item => ({
            issueNumber: String(item?.issueNumber ?? ''),
            number: String(item?.number ?? '').replace(/\D/g, '').slice(-1),
            color: String(item?.color ?? ''),
            size: String(item?.size ?? '')
        })).filter(item => /^\d+$/.test(item.issueNumber) && /^[0-9]$/.test(item.number));
    } catch (error) {
        console.error('[COMBINED SOURCE ERROR]', error?.message || error);
        return null;
    }
}

// Fetch only the bounded 100 rows required by 3.html. This is the sole
// source for BIG/SMALL mode, including both the target period and settlement.
async function fetchWhimsicalHistory() {
    try {
        const response = await axios.get(WHIMSICAL_SOURCE_URL + '?pageSize=100&t=' + Date.now(), {
            headers: {
                'Accept': 'application/json',
                'Cache-Control': 'no-cache, no-store, max-age=0',
                'Pragma': 'no-cache',
                'Origin': 'https://whimsical-buttercream-00c705.netlify.app',
                'Referer': 'https://whimsical-buttercream-00c705.netlify.app/',
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 10000,
            maxContentLength: 512 * 1024,
            maxBodyLength: 512 * 1024,
            validateStatus: status => status >= 200 && status < 300
        });
        const raw = Array.isArray(response.data?.data?.list) ? response.data.data.list : [];
        return raw.slice(0, 100).map(item => ({
            issueNumber: String(item?.issueNumber ?? item?.issue ?? ''),
            number: String(item?.number ?? item?.winNumber ?? '').replace(/\D/g, '').slice(-1)
        })).filter(item => /^\d+$/.test(item.issueNumber) && /^[0-9]$/.test(item.number));
    } catch (error) {
        console.error('[WHIMSICAL SOURCE ERROR] retryable:', error?.message || error);
        return null;
    }
}

async function fetchLuciferFullHistory() {
    try {
        const response = await axios.get(LUCIFER_FULL_HISTORY_URL + '?_=' + Date.now(), {
            headers: { 'Accept': 'application/json', 'Cache-Control': 'no-cache, no-store', 'Pragma': 'no-cache', 'User-Agent': 'Mozilla/5.0' },
            timeout: 12000,
            maxContentLength: 128 * 1024 * 1024,
            maxBodyLength: 128 * 1024 * 1024,
            validateStatus: status => status >= 200 && status < 300
        });
        const raw = Array.isArray(response.data?.data) ? response.data.data : [];
        return raw.map(item => ({
            issueNumber: String(item?.issueNumber ?? item?.issue ?? ''),
            number: Number.parseInt(String(item?.number ?? '').replace(/\D/g, '').slice(-1), 10),
            size: String(item?.size ?? '').toUpperCase(),
            color: String(item?.color ?? '').split(',')[0].toUpperCase()
        })).filter(item => /^\d+$/.test(item.issueNumber) && Number.isInteger(item.number) && item.number >= 0 && item.number <= 9);
    } catch (error) {
        console.error('[LUCIFER FULL HISTORY ERROR]', error?.message || error);
        return [];
    }
}

function getCombinedStrategySize(n) {
    const mapping = ['BIG', 'BIG', 'SMALL', 'SMALL', 'SMALL', 'BIG', 'SMALL', 'SMALL', 'SMALL', 'BIG'];
    return mapping[Number(n)] || null;
}


/* ============================================================
   BIG/SMALL ENSEMBLE FOR BIGSMALL+NUMBER MODE
   Markov + Momentum + Reversal over newest-first draw history.
   The number leg continues to use the existing walk-forward selector.
============================================================ */
function combinedHistorySizes(list) {
    return (Array.isArray(list) ? list : [])
        .map(getResultNumber)
        .filter(n => Number.isInteger(n))
        .map(getSizeFromNumber);
}

function combinedMarkov(sizes) {
    if (sizes.length < 12) return { side: sizes[0] || 'BIG', prob: 0.5, weight: 0 };
    const current = sizes[0], previous = sizes[1];
    let big1 = 1, small1 = 1, big2 = 1, small2 = 1;
    for (let i = 1; i < sizes.length; i++) {
        if (sizes[i] === current) sizes[i - 1] === 'BIG' ? big1++ : small1++;
    }
    for (let i = 2; i < sizes.length; i++) {
        if (sizes[i] === current && sizes[i - 1] === previous) {
            sizes[i - 2] === 'BIG' ? big2++ : small2++;
        }
    }
    const p1 = big1 / (big1 + small1);
    const p2 = big2 / (big2 + small2);
    const secondOrderWeight = Math.min(0.5, (big2 + small2 - 2) / 12);
    const combined = p1 * (1 - secondOrderWeight) + p2 * secondOrderWeight;
    const edge = Math.abs(combined - 0.5) * 2;
    return {
        side: combined >= 0.5 ? 'BIG' : 'SMALL',
        prob: Math.max(combined, 1 - combined),
        weight: Math.min(1, edge * 1.35)
    };
}

function combinedMomentum(sizes) {
    if (sizes.length < 12) return { side: sizes[0] || 'BIG', prob: 0.5, weight: 0 };
    const windows = [{ n: 6, decay: 0.78, weight: 0.30 }, { n: 16, decay: 0.90, weight: 0.70 }];
    let big = 0, small = 0;
    for (const window of windows) {
        let b = 0, s = 0;
        for (let i = 0; i < Math.min(window.n, sizes.length); i++) {
            const value = Math.pow(window.decay, i);
            sizes[i] === 'BIG' ? b += value : s += value;
        }
        const total = b + s || 1;
        if (b >= s) big += ((b - s) / total) * window.weight;
        else small += ((s - b) / total) * window.weight;
    }
    const total = big + small || 1;
    const edge = Math.abs(big - small) / total;
    return { side: big >= small ? 'BIG' : 'SMALL', prob: 0.5 + edge * 0.45, weight: Math.min(1, edge * 1.35) };
}

function combinedReversal(sizes) {
    let streak = 1;
    for (let i = 1; i < sizes.length; i++) {
        if (sizes[i] === sizes[0]) streak++;
        else break;
    }
    if (streak < 4) return { side: sizes[0] || 'BIG', prob: 0.5, weight: 0 };
    const softLimit = sizes[0] === 'BIG' ? 4 : 6;
    if (streak < softLimit) return { side: sizes[0], prob: 0.5, weight: 0.10 };
    const weight = Math.min(0.90, 0.42 + (streak - softLimit + 1) * 0.12);
    return { side: sizes[0] === 'BIG' ? 'SMALL' : 'BIG', prob: 0.5 + weight * 0.30, weight };
}

function getCombinedEnsembleSize(list) {
    const sizes = combinedHistorySizes(list);
    if (sizes.length < 12) return null;
    const models = [
        { name: 'Markov', out: combinedMarkov(sizes) },
        { name: 'Momentum', out: combinedMomentum(sizes) },
        { name: 'Reversal', out: combinedReversal(sizes) }
    ];
    let bigScore = 0, smallScore = 0, totalWeight = 0;
    for (const model of models) {
        const weight = Math.max(0, Math.min(1, model.out.weight || 0));
        const probability = Math.max(0.5, Math.min(0.95, model.out.prob || 0.5));
        if (model.out.side === 'BIG') {
            bigScore += probability * weight;
            smallScore += (1 - probability) * weight;
        } else {
            smallScore += probability * weight;
            bigScore += (1 - probability) * weight;
        }
        totalWeight += weight;
    }
    const bigProbability = totalWeight ? bigScore / totalWeight : 0.5;
    let side = bigProbability >= 0.5 ? 'BIG' : 'SMALL';
    let margin = Math.abs(bigProbability - (1 - bigProbability));
    const active = models.filter(model => model.out.weight > 0.12);
    let agree = active.filter(model => model.out.side === side).length;
    if (margin < 0.07) {
        const strongest = models.reduce((best, model) => !best || model.out.weight > best.out.weight ? model : best, null);
        if (strongest && strongest.out.weight > 0.20) {
            side = strongest.out.side;
            margin = Math.max(margin, 0.08);
            agree = active.filter(model => model.out.side === side).length;
        }
    }
    let confidence = 50 + margin * 74;
    if (active.length === 3) confidence += agree === 3 ? 13 : agree === 2 ? 6 : 0;
    else if (active.length === 2 && agree === 2) confidence += 6;
    return {
        side,
        confidence: Math.max(52, Math.min(96, Math.round(confidence))),
        modelText: models.map(model => `${model.name}:${model.out.side}`).join(' | '),
        agreement: `${agree}/${active.length}`,
        historySize: sizes.length
    };
}

/* ============================================================
   ALL HISTORY ANALYSIS: SIZE + COLOUR + NUMBER
   Uses every record returned in the API data array with conditional transition counts and walk-forward validation.
   It reports empirical rates; it does not guarantee future results.
============================================================ */
function analysisColor(row) {
    const raw = String(row?.color || '').split(',')[0].trim().toUpperCase();
    if (raw === 'RED' || raw === 'GREEN' || raw === 'VIOLET') return raw;
    const n = getResultNumber(row);
    return Number.isInteger(n) && typeof getActualColorBase === 'function'
        ? String(getActualColorBase(n)).toUpperCase()
        : '';
}

function analyze24kHistory(fullHistory, latestNumber, currentSize, currentColor) {
    const rows = (Array.isArray(fullHistory) ? fullHistory : []).map(row => ({
        number: getResultNumber(row),
        size: String(row?.size || '').toUpperCase() || (getResultNumber(row) >= 5 ? 'BIG' : 'SMALL'),
        color: analysisColor(row),
        issueNumber: String(row?.issueNumber || '')
    })).filter(row => Number.isInteger(row.number) && (row.size === 'BIG' || row.size === 'SMALL'));
    if (rows.length < 30) return null;

    const contextSize = currentSize || getSizeFromNumber(latestNumber);
    const contextColor = currentColor || analysisColor({ number: latestNumber });
    const sizeCounts = { BIG: 1, SMALL: 1 };
    const numberCounts = {};
    for (let n = 0; n <= 9; n++) numberCounts[n] = 1;
    let contextSamples = 0;
    let colourSamples = 0;

    // Newest-first: row[i - 1] is the historical next outcome for row[i].
    for (let i = 2; i < rows.length; i++) {
        const target = rows[i];
        const next = rows[i - 1];
        const exactContext = target.size === contextSize && (!contextColor || target.color === contextColor);
        const sizeContext = target.size === contextSize;
        const colorContext = contextColor && target.color === contextColor;
        const recencyWeight = 0.65 + 0.35 / (1 + i / 500);
        if (exactContext) {
            sizeCounts[next.size] += recencyWeight;
            if (next.number >= 0 && next.number <= 9) numberCounts[next.number] += recencyWeight;
            contextSamples++;
        } else if (sizeContext) {
            sizeCounts[next.size] += 0.35 * recencyWeight;
            if (next.number >= 0 && next.number <= 9) numberCounts[next.number] += 0.20 * recencyWeight;
        }
        if (colorContext) {
            sizeCounts[next.size] += 0.20 * recencyWeight;
            if (next.number >= 0 && next.number <= 9) numberCounts[next.number] += 0.12 * recencyWeight;
            colourSamples++;
        }
    }

    const sizeTotal = sizeCounts.BIG + sizeCounts.SMALL;
    const predictedSize = sizeCounts.BIG >= sizeCounts.SMALL ? 'BIG' : 'SMALL';
    const sizeConfidence = Math.round(Math.max(sizeCounts.BIG, sizeCounts.SMALL) / sizeTotal * 100);
    // User-requested opposite pool: BIG => 0-4, SMALL => 5-9.
    const numberPool = predictedSize === 'BIG' ? [0, 1, 2, 3, 4] : [5, 6, 7, 8, 9];
    const predictedNumber = numberPool.slice().sort((a, b) => numberCounts[b] - numberCounts[a] || a - b)[0];
    const poolTotal = numberPool.reduce((sum, n) => sum + numberCounts[n], 0);
    const numberConfidence = Math.round((numberCounts[predictedNumber] / poolTotal) * 100);

    // Walk-forward estimate for the same context rule, limited to recent 2,000 rows.
    let tested = 0, hits = 0;
    const limit = rows.length - 1;
    for (let i = 2; i < limit; i++) {
        const target = rows[i], actual = rows[i - 1];
        if (target.size !== contextSize || (contextColor && target.color !== contextColor)) continue;
        const pool = predictedSize === 'BIG' ? [0,1,2,3,4] : [5,6,7,8,9];
        const candidate = pool.slice().sort((a,b) => {
            const ca = rows.slice(i + 1, Math.min(rows.length, i + 201)).filter(r => r.number === a).length;
            const cb = rows.slice(i + 1, Math.min(rows.length, i + 201)).filter(r => r.number === b).length;
            return cb - ca || a - b;
        })[0];
        tested++;
        if (candidate === actual.number) hits++;
    }

    return {
        size: predictedSize,
        number: predictedNumber,
        sizeConfidence,
        numberConfidence,
        contextSamples,
        colourSamples,
        tested,
        hits,
        walkForwardRate: tested ? Math.round(hits / tested * 100) : 0,
        context: `${contextSize}+${contextColor || 'ANY'}`,
        sourceRows: rows.length
    };
}

async function getCombinedSourcePrediction(list, userId) {
    const latest = Array.isArray(list) && list[0];
    const n = Number.parseInt(String(latest?.number ?? ''), 10);
    if (!latest || !Number.isInteger(n) || n < 0 || n > 9) {
        return { skip: true, reason: 'One-minute source returned no valid latest result' };
    }

    // Use the requested ensemble for the SIZE leg. If history is too short,
    // retain the original supplied Netlify mapping as a deterministic fallback.
    const mapping = ['BIG', 'BIG', 'SMALL', 'SMALL', 'SMALL', 'BIG', 'SMALL', 'SMALL', 'SMALL', 'BIG'];
    const sourceSize = mapping[n];
    const ensemble = getCombinedEnsembleSize(list);
    let size = ensemble?.side || sourceSize;
    let oppositePool = size === 'BIG' ? [0, 1, 2, 3, 4] : [5, 6, 7, 8, 9];
    const cacheKey = `${String(latest.issueNumber ?? latest.issue)}:${n}:${size}`;
    if (getCombinedSourcePrediction._cache?.key === cacheKey) {
        return getCombinedSourcePrediction._cache.signal;
    }
    const fullHistory = await fetchLuciferFullHistory();
    if (fullHistory.length < 2) {
        return { skip: true, reason: 'Lucifer full history unavailable for shared number selection' };
    }

    const currentSize = String(latest?.size || getSizeFromNumber(n)).toUpperCase();
    const currentColor = String(latest?.color || '').split(',')[0].toUpperCase();
    const deepAnalysis = analyze24kHistory(fullHistory, n, currentSize, currentColor);
    if (deepAnalysis?.size) {
        size = deepAnalysis.size;
        oppositePool = size === 'BIG' ? [0, 1, 2, 3, 4] : [5, 6, 7, 8, 9];
    }
    const netlifySizeForNumber = number => mapping[Number(number)];
    const poolForNumber = number => netlifySizeForNumber(number) === 'BIG'
        ? [0, 1, 2, 3, 4] : [5, 6, 7, 8, 9];
    const contextMatches = (row, rule, targetSize, targetColor) => {
        if (rule === 'EXACT-SIZE-COLOR') return row.size === targetSize && row.color === targetColor;
        if (rule === 'SIZE-ONLY') return row.size === targetSize;
        if (rule === 'COLOR-ONLY') return row.color === targetColor;
        return true;
    };
    const findNearestPrediction = (index, rule) => {
        const target = fullHistory[index];
        const pool = poolForNumber(target.number);
        // Keep one record between the target and its historical match so the
        // target itself can never be counted as the match's future outcome.
        for (let olderIndex = index + 2; olderIndex < fullHistory.length; olderIndex++) {
            const older = fullHistory[olderIndex];
            const following = fullHistory[olderIndex - 1];
            if (!following || !pool.includes(following.number)) continue;
            if (contextMatches(older, rule, target.size, target.color)) return following.number;
        }
        return null;
    };

    // Lightweight online ML candidate. It learns a multiclass score for each
    // number from period/result/size/colour features, then is evaluated in
    // chronological walk-forward order before being allowed to win selection.
    const mlFeatures = row => {
        const digits = String(row.issueNumber || '').replace(/\D/g, '');
        return [
            1,
            (Number.parseInt(digits.slice(-3), 10) || 0) / 999,
            (Number.parseInt(digits.slice(-1), 10) || 0) / 9,
            row.number / 9,
            row.size === 'BIG' ? 1 : -1,
            row.color === 'RED' ? 1 : -1
        ];
    };
    const dot = (weights, features) => weights.reduce((sum, value, i) => sum + value * features[i], 0);
    const mlWeights = Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [n, [0, 0, 0, 0, 0, 0]]));
    let mlTested = 0;
    let mlHits = 0;
    for (let index = fullHistory.length - 1; index >= 2; index--) {
        const target = fullHistory[index];
        const actual = fullHistory[index - 1]?.number;
        const pool = poolForNumber(target.number);
        if (!pool.includes(actual)) continue;
        const features = mlFeatures(target);
        const predicted = pool.slice().sort((a, b) => dot(mlWeights[b], features) - dot(mlWeights[a], features) || a - b)[0];
        mlTested++;
        if (predicted === actual) mlHits++;
        if (predicted !== actual) {
            for (let i = 0; i < features.length; i++) {
                mlWeights[actual][i] += features[i];
                mlWeights[predicted][i] -= features[i];
            }
        }
    }
    const currentFeatures = mlFeatures({
        issueNumber: latest.issueNumber ?? latest.issue,
        number: n,
        size: currentSize,
        color: currentColor
    });
    const mlNumber = oppositePool.slice().sort((a, b) =>
        dot(mlWeights[b], currentFeatures) - dot(mlWeights[a], currentFeatures) || a - b
    )[0];

    // Select the rule that performed best in a walk-forward test. This avoids
    // choosing a number merely because it appeared most often overall.
    const rules = ['EXACT-SIZE-COLOR', 'SIZE-ONLY', 'COLOR-ONLY', 'RECENT-POOL'];
    const reports = rules.map(rule => {
        let tested = 0;
        let hits = 0;
        const limit = fullHistory.length - 1;
        for (let index = 1; index < limit; index++) {
            const predicted = rule === 'RECENT-POOL'
                ? findNearestPrediction(index, 'RECENT-POOL')
                : findNearestPrediction(index, rule);
            if (predicted === null) continue;
            tested++;
            if (predicted === fullHistory[index - 1].number) hits++;
        }
        return { rule, tested, hits, rate: tested ? hits / tested : 0 };
    });
    reports.push({ rule: 'ML-PERCEPTRON', tested: mlTested, hits: mlHits, rate: mlTested ? mlHits / mlTested : 0, mlNumber });
    reports.sort((a, b) => b.rate - a.rate || b.tested - a.tested || a.rule.localeCompare(b.rule));

    const selectedRule = reports[0];
    const selectedNumber = selectedRule?.rule === 'ML-PERCEPTRON'
        ? selectedRule.mlNumber
        : selectedRule?.rule === 'RECENT-POOL'
        ? findNearestPrediction(0, 'RECENT-POOL')
        : findNearestPrediction(0, selectedRule?.rule || 'EXACT-SIZE-COLOR');
    const number = deepAnalysis?.number ?? selectedNumber ?? oppositePool[0];
    const confidence = selectedRule?.tested ? Math.round(selectedRule.rate * 100) : 0;

    const signal = {
        type: 'COMBINED',
        val: size,
        number,
        mode: 'ALL HISTORY OPPOSITE SIZE+COLOUR+NUMBER ANALYSIS',
        pat: 'MARKOV+MOMENTUM+REVERSAL',
        pattern: `${ensemble ? ensemble.modelText : 'SOURCE-MAPPING-FALLBACK'} | SIZE-${size} | OPPOSITE-POOL`,
        sizeConfidence: ensemble?.confidence ?? 50,
        modelAgreement: ensemble?.agreement || 'fallback',
        numberConfidence: deepAnalysis?.numberConfidence ?? confidence,
        historicalRows: deepAnalysis?.sourceRows || fullHistory.length,
        contextSamples: deepAnalysis?.contextSamples || 0,
        walkForwardRate: deepAnalysis?.walkForwardRate || 0,
        decisionReason:
            `Size ${size}; opposite number pool ${oppositePool.join(',')}; ` +
            `models ${ensemble?.agreement || 'n/a'}; pool ${oppositePool.join(',')} | ` +
            `Lucifer context ${currentSize || 'SIZE'}+${currentColor || 'COLOR'} | ` +
            `rule ${selectedRule?.rule || 'FALLBACK'} walk-forward ${selectedRule?.hits || 0}/${selectedRule?.tested || 0} | ` +
            `selected ${number} | ALL rows ${deepAnalysis?.sourceRows || fullHistory.length} | ` +
            `context ${deepAnalysis?.contextSamples || 0} | walk-forward ${deepAnalysis?.walkForwardRate || 0}%`,
        bets: [
            { type: 'SIZE', val: size, kind: 'size' },
            { type: 'NUMBER', val: number, kind: 'number' }
        ]
    };
    getCombinedSourcePrediction._cache = { key: cacheKey, signal };
    return signal;
}

async function fetchLuciferOldHistoryForAnalysis() {
    try {
        const response = await axios.get(LUCIFER_OLD_ANALYSIS_URL + "?_=" + Date.now(), {
            headers: { "Accept": "application/json", "Cache-Control": "no-cache, no-store", "Pragma": "no-cache" },
            timeout: 8000,
            maxContentLength: 512 * 1024,
            maxBodyLength: 512 * 1024,
            validateStatus: status => status >= 200 && status < 300
        });
        const raw = Array.isArray(response.data)
            ? response.data
            : Array.isArray(response.data?.data)
                ? response.data.data
                : Array.isArray(response.data?.data?.list)
                    ? response.data.data.list
                    : [];
        // Use the complete history returned by Lucifer; do not cap it at 200.
        return raw.map((item, index) => ({
            issueNumber: String(item?.issueNumber ?? item?.issue ?? item?.period ?? index),
            number: String(
                item?.number ?? item?.winNumber ?? item?.result ?? item?.resultNumber ?? ''
            ).replace(/\D/g, '').slice(-1)
        })).filter(item => /^[0-9]$/.test(item.number));
    } catch (error) {
        console.error('[LUCIFER OLD HISTORY ERROR]', error?.message || error);
        return [];
    }
}

// History is newest-first. Each older record at index i is followed by the
// newer record at index i - 1. Compare several historical rules and choose
// the strongest measured next-size edge for the current period.
function analyzeLuciferNextResult(historyList, currentResult, currentPeriod, state) {
    const current = Number(currentResult);
    if (!Number.isInteger(current) || current < 0 || current > 9) return null;

    const history = (Array.isArray(historyList) ? historyList : [])
        .map((item, index) => ({
            number: getResultNumber(item),
            issue: String(item?.issueNumber ?? item?.issue ?? item?.period ?? index)
        }))
        .filter(item => item.number !== null);

    const periodText = String(currentPeriod ?? '');
    const periodLast = periodText.replace(/\D/g, '').slice(-1);
    const periodSecondLast = periodText.replace(/\D/g, '').slice(-2);

    const rules = [
        {
            name: `RESULT-${current}`,
            match: item => item.number === current
        },
        {
            name: `PERIOD-LAST-${periodLast || '?'}`,
            match: item => periodLast && item.issue.replace(/\D/g, '').slice(-1) === periodLast
        },
        {
            name: `PERIOD-LAST2-${periodSecondLast || '?'}`,
            match: periodSecondLast && item.issue.replace(/\D/g, '').slice(-2) === periodSecondLast
        },
        {
            name: `RESULT-${current}+PERIOD-${periodLast || '?'}`,
            match: item => item.number === current && periodLast &&
                item.issue.replace(/\D/g, '').slice(-1) === periodLast
        }
    ].filter(rule => rule.name.indexOf('?') === -1);

    const candidates = [];
    for (const rule of rules) {
        const sizeCounts = { BIG: 0, SMALL: 0 };
        const numberCounts = Array(10).fill(0);
        let samples = 0;

        for (let index = 1; index < history.length; index++) {
            if (!rule.match(history[index])) continue;
            const following = history[index - 1]?.number;
            if (following === null || following === undefined) continue;
            numberCounts[following]++;
            sizeCounts[getSizeFromNumber(following)]++;
            samples++;
        }

        if (samples < 8) continue;
        const rankedSizes = Object.entries(sizeCounts)
            .map(([size, count]) => ({ size, count }))
            .sort((a, b) => b.count - a.count);
        const bestSize = rankedSizes[0];
        const secondSize = rankedSizes[1];
        if (!bestSize || !secondSize || bestSize.count < 2) continue;

        const confidence = Math.round((bestSize.count / samples) * 100);
        const edge = (bestSize.count - secondSize.count) / samples;
        candidates.push({ rule, bestSize, confidence, edge, samples, numberCounts });
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) =>
        b.confidence - a.confidence || b.edge - a.edge || b.samples - a.samples
    );

    const selected = candidates[0];
    if (selected.confidence < 90 || selected.edge < 0.15) return null;

    const representativeNumber = selected.numberCounts
        .map((count, number) => ({ number, count }))
        .filter(item => getSizeFromNumber(item.number) === selected.bestSize.size)
        .sort((a, b) => b.count - a.count || a.number - b.number)[0]?.number ?? null;

    const predictionSize = selected.bestSize.size;
    const predictionColor = predictionSize === 'BIG' ? 'RED' : 'GREEN';
    // Under the requested 0–4/5–9 mapping, colour and size describe the
    // same event. Use SIZE as the deterministic tie-breaker for this period.
    const mode = 'SIZE';

    return {
        type: mode === 'COLOUR' ? 'COLOR' : 'SIZE',
        val: mode === 'COLOUR' ? predictionColor : predictionSize,
        number: representativeNumber,
        conf: selected.confidence,
        historyBased: true,
        pat: 'LUCIFER-PATTERN',
        mode,
        pattern: selected.rule.name,
        decisionReason:
            `${selected.rule.name}: ${predictionSize} ` +
            `(${selected.bestSize.count}/${selected.samples}, ${selected.confidence}%) | ` +
            `representative ${representativeNumber} | ${predictionColor}`,
        bets: [{
            type: mode === 'COLOUR' ? 'COLOR' : 'SIZE',
            val: mode === 'COLOUR' ? predictionColor : predictionSize,
            kind: mode === 'COLOUR' ? 'color' : 'size'
        }]
    };
}

function calculateHistoryDigit(issueNumber, resultNumber) {
    const period = String(issueNumber ?? '');
    const result = Number(resultNumber);
    if (!/^\d+$/.test(period) || !Number.isInteger(result) || result < 0 || result > 9) return null;
    let nextPeriod;
    try {
        nextPeriod = (BigInt(period) + 1n).toString();
    } catch (_) {
        return null;
    }
    const nextLast3 = Number.parseInt(nextPeriod.slice(-3), 10);
    const answer = nextLast3 * Math.exp(result);
    const digits = String(answer).replace('.', '').substring(0, 14);
    const digit = Number.parseInt(digits.charAt(digits.length - 1), 10);
    return Number.isInteger(digit) && digit >= 0 && digit <= 9 ? digit : null;
}

function getHistoricalColor(number) {
    const n = Number(number);
    if (!Number.isInteger(n) || n < 0 || n > 9) return null;
    // Base colour used by the game: 0 is RED+VIOLET and 5 is GREEN+VIOLET.
    return n % 2 === 0 ? 'RED' : 'GREEN';
}

function analyzeCalculatedResultMode(historyList, currentPeriod, currentResult) {
    const currentDigit = calculateHistoryDigit(currentPeriod, currentResult);
    if (currentDigit === null) return null;

    const rows = (Array.isArray(historyList) ? historyList : [])
        .map((item, index) => ({
            issue: String(item?.issueNumber ?? item?.issue ?? item?.period ?? index),
            result: getResultNumber(item)
        }))
        .filter(row => row.result !== null);

    const stats = Array.from({ length: 10 }, () => ({
        samples: 0,
        size: { BIG: 0, SMALL: 0 },
        color: { RED: 0, GREEN: 0 },
        numbers: Array(10).fill(0)
    }));

    for (let index = 1; index < rows.length; index++) {
        const calculatedDigit = calculateHistoryDigit(rows[index].issue, rows[index].result);
        const actualNext = rows[index - 1].result;
        if (calculatedDigit === null || actualNext === null) continue;

        const bucket = stats[calculatedDigit];
        bucket.samples++;
        bucket.size[getSizeFromNumber(actualNext)]++;
        bucket.color[getHistoricalColor(actualNext)]++;
        bucket.numbers[actualNext]++;
    }

    const bucket = stats[currentDigit];
    if (!bucket || bucket.samples < 8) return null;

    const candidates = [
        { type: 'SIZE', values: bucket.size },
        { type: 'COLOR', values: bucket.color }
    ].flatMap(candidate => Object.entries(candidate.values).map(([value, wins]) => ({
        type: candidate.type,
        value,
        wins,
        samples: bucket.samples,
        confidence: Math.round((wins / bucket.samples) * 100),
        losses: bucket.samples - wins
    }))).sort((a, b) => b.confidence - a.confidence || b.wins - a.wins);

    const best = candidates[0];
    const alternate = candidates.find(item => item.type === best.type && item.value !== best.value);
    if (!best || !alternate || best.confidence < 90 || best.confidence - alternate.confidence < 15) {
        return null;
    }

    const representativeNumber = bucket.numbers
        .map((count, number) => ({ number, count }))
        .filter(item => best.type === 'SIZE'
            ? getSizeFromNumber(item.number) === best.value
            : getHistoricalColor(item.number) === best.value)
        .sort((a, b) => b.count - a.count || a.number - b.number)[0]?.number ?? null;

    return {
        type: best.type,
        val: best.value,
        number: representativeNumber,
        conf: best.confidence,
        historyBased: true,
        pat: 'CALC-RESULT-HISTORY',
        mode: best.type === 'COLOR' ? 'COLOUR' : 'SIZE',
        pattern: `CALC-${currentDigit}`,
        decisionReason:
            `Calculation result ${currentDigit}: ${best.type} ${best.value} ` +
            `won ${best.wins}/${best.samples} (${best.confidence}%) | ` +
            `representative ${representativeNumber}`,
        bets: [{
            type: best.type,
            val: best.value,
            kind: best.type === 'COLOR' ? 'color' : 'size'
        }]
    };
}

// Fallback copied from the supplied APK analysis. This is random UI output,
// not a historical prediction, so it is never eligible for AutoBet.
function generateRandomBigSmallFallback(period) {
    const n = Math.floor(Math.random() * 10);
    const size = n <= 4 ? 'SMALL' : 'BIG';
    return {
        type: 'SIZE',
        val: size,
        number: n,
        conf: 0,
        fallback: true,
        historyBased: false,
        pat: 'RANDOM-FALLBACK',
        mode: 'SIZE',
        pattern: 'RANDOM-0-9',
        decisionReason: `APK fallback: random ${n} -> ${size} for period ${period}`,
        bets: [{ type: 'SIZE', val: size, kind: 'size' }]
    };
}

async function fetchListForUser(userId) {
    const mode = String(autobetCfg[userId]?.mode || '').toUpperCase();
    if (mode === 'COMBINED') return await fetchCombinedSourceList();
    // BIG/SMALL mode follows the uploaded 3.html source exactly.
    return await fetchWhimsicalHistory();
}

// Helper parser function
async function parseBalanceResponse(r) {
    if (r.data && r.data.code === 0 && r.data.data && typeof r.data.data.balance !== 'undefined') {
        return { success: true, balance: r.data.data.balance };
    }
    return {
        success: false,
        message: r.data && r.data.msg ? r.data.msg : "Token expired or invalid"
    };
}

async function getLiveBalance(userId, chatId = null) {
    let token = getToken(userId);
    
    // Do not auto-login just because the token is missing.
    // Login must be started explicitly from the Login button/command.
    if (!token) return { success: false, message: "No token - press Login first" };

    const baseParams = {
        language: "en",
        random: Math.floor(Math.random() * 1e12)
    };
    const signature = makeBetSign(baseParams);
    const timestamp = Math.floor(Date.now() / 1000);
    const qs = new URLSearchParams({
        ...baseParams,
        signature,
        timestamp
    }).toString();
    const url = "https://api.ar-lottery01.com/api/Lottery/GetBalance?" + qs;
    const session = userSessions[String(userId)] || {};
    const headers = {
        "Authorization": "Bearer " + token,
        "authorization": "Bearer " + token,
        "Accept": "application/json, text/plain, */*",
        "Origin": SITE_URL,
        "Referer": SITE_URL,
        "Ar-Origin": SITE_URL,
        ...(session.cookieHeader ? { "Cookie": session.cookieHeader } : {}),
        "Sec-Ch-Ua": '"Chromium";v="139"',
        "Sec-Ch-Ua-Mobile": "?1",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
        "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
    };

    try {
        const r = await axios.get(url, { headers, timeout: 10000 });
        const parsed = await parseBalanceResponse(r);
        if (parsed.success) {
            if (!profitTrack[userId]) profitTrack[userId] = { totalBets:0, wins:0, losses:0, pnl:0, winStreak:0, lossStreak:0, maxW:0, maxL:0, totalBetAmount: 0 };
            profitTrack[userId].walletBalance = Number(parsed.balance) || 0;
        }
        return parsed;
    } catch (e) {
        const responseData = e.response?.data;
        const responseMessage = responseData?.msg || responseData?.message || responseData?.error;
        const errMsg = responseMessage || (e.response?.status ? `HTTP ${e.response.status}` : e.message) || "API Error";
        console.error(`[BALANCE ERROR] status=${e.response?.status || "none"} response=${JSON.stringify(responseData || {})}`);

        const fallback = balanceFallbacks[String(userId)];
        const fallbackAge = fallback ? Date.now() - fallback.capturedAt : Infinity;
        if (e.response?.status === 403 && Number.isFinite(fallback?.balance) && fallbackAge < 10 * 60 * 1000) {
            console.warn(`[BALANCE FALLBACK] Using wallet page value for user ${userId}; age=${Math.round(fallbackAge / 1000)}s`);
            if (!profitTrack[userId]) profitTrack[userId] = { totalBets:0, wins:0, losses:0, pnl:0, winStreak:0, lossStreak:0, maxW:0, maxL:0, totalBetAmount: 0 };
            profitTrack[userId].walletBalance = fallback.balance;
            return { success: true, balance: fallback.balance, source: "wallet-page" };
        }
        return { success: false, message: errMsg };
    }
}

function initUser(id) {
    userLastSeen[id] = Date.now();
    if (!stats[id])        stats[id]        = { total:0,win:0,loss:0,lossStreak:0,winStreak:0,maxWinStreak:0,maxLossStreak:0,levelWins:{},sizeLevelWins:{},numberLevelWins:{} };
    for (const field of ["total", "win", "loss", "lossStreak", "winStreak", "maxWinStreak", "maxLossStreak"]) {
        if (!Number.isFinite(Number(stats[id][field])) || stats[id][field] < 0) stats[id][field] = 0;
    }
   if (!userStates[id])   userStates[id]   = { resultHistory:[], skipCount:0, currentMode:null, lastPrediction:null, sizePredictionMode:'ANALYSIS', sizeOppositeActive:false, sixPredictionLock:null, activeSixChannel:null, channelLosses:{ SIZE:0, COLOR:0 }, channelSwitches:0, skipPeriodsRemaining:0, lastFiveSameIssue:null, fiveSameSkipActive:false, specialPatternSkipActive:false, lastWinPattern:null, lastWinChannel:null, lastSamePatternSwitchIssue:null };
    if (!sentPeriods[id])  sentPeriods[id]  = new Set();
    if (!autobetCfg[id])   autobetCfg[id]   = { 
        watch:false, 
        watchLoss:2, 
        baseBet:1, 
        maxLvl:5, 
        enabled:false,
        mode:"SIZE", // SIZE, COLOR, NUMBER, or COMBINED
        customBets:[1,3,9,27,81],
        customSizeBets:[1,2,4,8,16],
        customNumberBets:[1,9,81,729,6561],
        targetProfit: 1000,    // NEW: Profit target set panna
        restartDelay: 1,       // NEW: Restart time (hours) set panna
        profitPlan: {
            enabled: false,
            startLevel: 1,
            currentLevel: 1,
            profitSwitchStep: 0,
            nextProfitSwitch: 0
        }
    };
    if (!["SIZE", "COLOR", "NUMBER", "COMBINED"].includes(autobetCfg[id].mode)) autobetCfg[id].mode = "SIZE";
    if (!Array.isArray(autobetCfg[id].customBets) || !autobetCfg[id].customBets.length) autobetCfg[id].customBets = [1,3,9,27,81];
    if (!Array.isArray(autobetCfg[id].customSizeBets) || !autobetCfg[id].customSizeBets.length) autobetCfg[id].customSizeBets = [1,2,4,8,16];
    if (!Array.isArray(autobetCfg[id].customNumberBets) || !autobetCfg[id].customNumberBets.length) autobetCfg[id].customNumberBets = [1,9,81,729,6561];
    if (!autobetState[id]) autobetState[id] = { 
        level:1,
        sizeLevel:1,
        numberLevel:1,
        consecutiveLoss:0,
        inMart:false,
        lastWinLevel:null,
        lastWinMode:null,
        isWaiting: false,
        nextStartTime: null,
        levelHistory: {},
        sizeLevelHistory: {},
        numberLevelHistory: {},
        // One live-bet loss puts the engine into watch mode.
        // The next live bet is allowed only after a watch prediction wins.
        waitingForWatchWin: false,
        lastOutcome: null
    };
    if (!autobetState[id].levelHistory || typeof autobetState[id].levelHistory !== "object") autobetState[id].levelHistory = {};
    if (!Number.isInteger(autobetState[id].sizeLevel) || autobetState[id].sizeLevel < 1) autobetState[id].sizeLevel = autobetState[id].level || 1;
    if (!Number.isInteger(autobetState[id].numberLevel) || autobetState[id].numberLevel < 1) autobetState[id].numberLevel = autobetState[id].level || 1;
    if (!autobetState[id].sizeLevelHistory || typeof autobetState[id].sizeLevelHistory !== "object") autobetState[id].sizeLevelHistory = {};
    if (!autobetState[id].numberLevelHistory || typeof autobetState[id].numberLevelHistory !== "object") autobetState[id].numberLevelHistory = {};
    if (!profitTrack[id])  profitTrack[id]  = { totalBets:0, wins:0, losses:0, pnl:0, winStreak:0, lossStreak:0, maxW:0, maxL:0, totalBetAmount: 0, lossStreakHits: 0 };
    if (!Number.isFinite(Number(profitTrack[id].maxW)) || profitTrack[id].maxW < 0) profitTrack[id].maxW = 0;
    if (!Number.isFinite(Number(profitTrack[id].maxL)) || profitTrack[id].maxL < 0) profitTrack[id].maxL = 0;
    if (!Number.isFinite(Number(profitTrack[id].winStreak)) || profitTrack[id].winStreak < 0) profitTrack[id].winStreak = 0;
    if (!Number.isFinite(Number(profitTrack[id].lossStreak)) || profitTrack[id].lossStreak < 0) profitTrack[id].lossStreak = 0;
    if (!Number.isInteger(profitTrack[id].lossStreakHits) || profitTrack[id].lossStreakHits < 0) profitTrack[id].lossStreakHits = 0;
}

function hasAccess(id) {
    if (Number(id) === Number(OWNER_ID)) return true;
    if (running[id] === true) return true;
    const expiry = usersAccess[id];
    return !!(expiry && Date.now() < expiry);
}
function daysLeft(id) {
    if (Number(id) === Number(OWNER_ID)) return "∞";
    if (running[id] === true) return "RUN";
    const expiry = usersAccess[id];
    if (!expiry) return "0";
    const left = (expiry - Date.now()) / 86400000;
    return left > 0 ? left.toFixed(1) : "0";
}
function isAdmin(id)    { return adminPasswords[id] !== undefined; }
function isAdminIn(id)  { return adminLoggedIn[id] === true; }
function getToken(id) {
    const key = String(id);
    // Read both stores for compatibility, then repair the canonical cache if needed.
    const token = normalizeToken(userTokens[key]) || normalizeToken(userCreds[key]?.token) || "";
    if (token && normalizeToken(userTokens[key]) !== token) userTokens[key] = token;
    return token;
}

function generateKey(days, by) {
    const k = "EARN WITH ME-"+crypto.randomBytes(3).toString('hex').toUpperCase()+"-"+crypto.randomBytes(2).toString('hex').toUpperCase();
    keyStore[k] = { days, used:false, usedBy:null, by:by||OWNER_ID, createdAt: Date.now() };
    const keys = Object.keys(keyStore);
    if (keys.length > MAX_KEYS) {
        for (const key of keys) {
            if (keyStore[key]?.used) delete keyStore[key];
            if (Object.keys(keyStore).length <= MAX_KEYS) break;
        }
    }
    return k;
}
function activateKey(userId, code) {
    const k = code.toUpperCase().trim();
    if (!keyStore[k])     return { ok:false, msg:"❌ Invalid key!" };
    if (keyStore[k].used) return { ok:false, msg:"❌ Key already used!" };

    const days = Number(keyStore[k].days) || 1;
    const currentExpiry = usersAccess[userId];
    const base = (currentExpiry && currentExpiry > Date.now()) ? currentExpiry : Date.now();
    const newExpiry = base + days * 86400000;

    keyStore[k].used=true;
    keyStore[k].usedBy=userId;
    usersAccess[userId] = newExpiry;
    return { ok:true, days, expiry:new Date(newExpiry).toLocaleString() };
}
function activeUsersList() {
    const now=Date.now();
    const ids = new Set(Object.keys(usersAccess));
    Object.keys(running).forEach(id => { if (running[id]) ids.add(id); });

    const list = [...ids].filter(id => Number(id) === Number(OWNER_ID) || running[id] || Number(usersAccess[id]) > now);
    if (!list.length) return "No active users.";

    return list.map(id => {
        if (Number(id) === Number(OWNER_ID)) return "🟢 " + id + " | ♾️ Unlimited";
        if (running[id]) return "🟢 " + id + " | ⚡ Running";
        const expiry = Number(usersAccess[id]) || 0;
        return "🟢 " + id + " | " + ((expiry - now) / 86400000).toFixed(1) + "d";
    }).join("\n");
}
function adminList() {
    const ids=Object.keys(adminPasswords);
    return ids.length ? ids.map(id=>"👤 "+id+" | "+(adminLoggedIn[id]?"🟢 Online":"🔴 Offline")).join("\n") : "No admins.";
}
function allKeysList() {
    const keys=Object.entries(keyStore);
    return keys.length ? keys.map(([k,v])=>k+" → "+(v.used?"✅ Used":"🟢 "+v.days+"d")).join("\n") : "No keys.";
}

function ownerMemberDetails() {
    const now = Date.now();
    const ids = new Set([
        ...Object.keys(usersAccess),
        ...Object.keys(userLastSeen),
        ...Object.keys(autobetCfg),
        ...Object.keys(autobetState),
        ...Object.keys(profitTrack),
        ...Object.keys(running)
    ]);
    ids.delete(String(OWNER_ID));
    if (!ids.size) return "No members found.";

    const money = value => "₹" + (Number(value) || 0).toFixed(2);
    const seq = values => Array.isArray(values) && values.length ? values.join(" → ") : "Default";

    return [...ids].sort((a, b) => Number(a) - Number(b)).map(uid => {
        initUser(uid);
        const cfg = autobetCfg[uid] || {};
        const st = autobetState[uid] || {};
        const pt = profitTrack[uid] || {};
        const expiry = Number(usersAccess[uid] || 0);
        const access = expiry > now ? ((expiry - now) / 86400000).toFixed(1) + " days left" : "No active access";
        const mode = modeLabel(cfg.mode);
        const levelHistory = Object.entries(st.levelHistory || {})
            .sort((a, b) => Number(a[0].slice(1)) - Number(b[0].slice(1)))
            .map(([level, count]) => level + ":" + count).join(" | ") || "None";
        const sizeWins = levelMapText(stats[uid]?.sizeLevelWins);
        const numberWins = levelMapText(stats[uid]?.numberLevelWins);

        let out = "👤 MEMBER " + uid + "\n";
        out += "Access      : " + access + "\n";
        out += "Running     : " + (running[uid] ? "YES" : "NO") + "\n";
        out += "Mode        : " + mode + "\n";
        out += "AutoBet     : " + (cfg.enabled ? "ON" : "OFF") + "\n";
        out += "Watch       : " + (cfg.watch ? "ON" : "OFF") + " | Loss limit " + (cfg.watchLoss ?? "-") + "\n";
        out += "Base fund   : " + money(cfg.baseBet) + "\n";
        out += "Max level   : L" + (cfg.maxLvl || 1) + "\n";
        out += "Current lvl : L" + (st.level || 1) + " | Size L" + (st.sizeLevel || 1) + " | Number L" + (st.numberLevel || 1) + "\n";
        out += "Normal fund : " + seq(cfg.customBets) + "\n";
        out += "Size fund   : " + seq(cfg.customSizeBets) + "\n";
        out += "Number fund : " + seq(cfg.customNumberBets) + "\n";
        out += "Target      : " + money(cfg.targetProfit) + " | Restart " + (cfg.restartDelay || 1) + " min\n";
        out += "Total bet   : " + money(pt.totalBetAmount) + "\n";
        out += "P&L         : " + (Number(pt.pnl) >= 0 ? "+" : "") + money(pt.pnl) + "\n";
        out += "Win/Loss    : " + (pt.wins || 0) + "W / " + (pt.losses || 0) + "L\n";
        out += "Level usage : " + levelHistory + "\n";
        if (cfg.mode === "COMBINED") out += "Wins by L   : Size " + sizeWins + " | Number " + numberWins + "\n";
        else out += "Wins by L   : " + levelMapText(stats[uid]?.levelWins) + "\n";
        out += "------------------------\n";
        return out;
    }).join("\n");
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
                "Origin": SITE_URL,
                "Referer": SITE_URL,
                "Ar-Origin": SITE_URL,
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
let loginLockStartedAt = {};
const LOGIN_LOCK_TIMEOUT_MS = 3 * 60 * 1000;
async function autoLogin(userId, chatId, silent = false) {
    const key = String(userId);
    const now = Date.now();
    // A crashed/closed browser must never permanently block the next Login attempt.
    if (loginLock[key] && now - Number(loginLockStartedAt[key] || 0) < LOGIN_LOCK_TIMEOUT_MS) {
        await logBoth(chatId, `⏳ Login is still running for user ${key}. Please wait a moment and press Login again.`);
        return false;
    }
    if (loginLock[key]) {
        console.warn(`[LOGIN LOCK] Clearing stale lock for user ${key}`);
        loginLock[key] = false;
        delete loginLockStartedAt[key];
    }
    loginLock[key] = true;
    loginLockStartedAt[key] = now;

    const creds = userCreds[userId] || {};
    const { phone, pass } = creds;

    if (!phone || !pass) {
        await logBoth(chatId, `[AUTO LOGIN] User ${userId} has no phone or password set.`);
        loginLock[key] = false;
        delete loginLockStartedAt[key];
        return false;
    }

    try {
        const token = await captchaLogin(userId, chatId, phone, pass, bot, logBoth);
        if (token) {
            const cleanToken = normalizeToken(token);
            if (!cleanToken) {
                throw new Error('captchaLogin returned an empty token');
            }
            // Treat the GetBalance token exactly like /setmytoken <token>.
            const applied = applyMyToken(userId, cleanToken);
            if (!applied.ok) {
                throw new Error(applied.reason || 'Token captured but could not be saved');
            }
            console.log(`[TOKEN SAVED] User ${userId}; token length=${applied.token.length}`);
            if (!silent) {
                await logBoth(chatId, `✅ [SUCCESS] Token captured for user ${userId}!`);
            }
            // Return the actual token so callers can use it immediately.
            return cleanToken;
        } else {
            if (!silent) {
                await logBoth(chatId, `❌ [FAILED] Login failed for user ${userId}`, true);
            }
            return false;
        }
    } catch (err) {
        await logBoth(chatId, `❌ Login Error for user ${userId}: ${err.message}`, true);
        return false;
    } finally {
        loginLock[key] = false;
        delete loginLockStartedAt[key];
    }
}

async function robustLogin(userId, chatId, silent = false) {
    let success = await autoLogin(userId, chatId, silent);
    if (!success && !silent && chatId) {
        await logBoth(chatId, "❌ Login failed. Will retry automatically.");
    }
    return success;
}

async function startLoginWithRetry(userId, chatId) {
    if (loginRetryTimers[userId]) {
        clearTimeout(loginRetryTimers[userId]);
        delete loginRetryTimers[userId];
    }

    await send(chatId, "⏳ We are trying to login. Please hold on 3-5 minutes, we will be back to you.");

    let attempts = 0;

    async function attemptLogin() {
        if (!hasAccess(userId)) {
            delete loginRetryTimers[userId];
            return false;
        }
        attempts++;
        const ok = await autoLogin(userId, chatId, true);
        if (ok) {
            initUser(userId);
            autobetCfg[userId].enabled = true;
            if (loginRetryTimers[userId]) {
                clearTimeout(loginRetryTimers[userId]);
                delete loginRetryTimers[userId];
            }
            await send(chatId, "✅ Login Success!\n🤖 AutoBet is now turned ON automatically!", { reply_markup: userMenu(userId) });
            return true;
        }
        loginRetryTimers[userId] = setTimeout(attemptLogin, 60 * 1000);
        return false;
    }

    return attemptLogin();
}

// ============================================================
//  PLACE BET
// ============================================================
// PLACE BET (Modified to capture token from response if available)
// ============================================================
// ============================================================
//  IMPROVED PLACE BET FUNCTION (Silent Retries & Multi-Request Fix)
// ============================================================
// ============================================================
async function placeBet(userId, chatId, period, prediction, predType, level, amountOverride) {
    // Missing token is not a relogin trigger. The user must press Login first.
    let token = normalizeToken(getToken(userId));
    if (!token || token.length < 20) {
        await send(chatId, "❌ Token இல்லை. முதலில் 🔐 Login press பண்ணு.");
        return false;
    }

    // Always re-read the repaired canonical token immediately before the request.
    token = getToken(String(userId));
    if (!token || token.length < 20) {
        await send(chatId, '❌ Token missing before bet request.');
        return false;
    }

    const cfg        = autobetCfg[userId];
    const fallbackAmount = cfg.customBets[level-1] || (cfg.baseBet * MULT[level-1]);
    const betMult   = Number.isFinite(Number(amountOverride)) ? Number(amountOverride) : fallbackAmount;
    let bc = "";

    const maxRetries = 5; 
    const retryDelayMs = 2000; 

    if (predType === "SIZE") bc = prediction === "BIG" ? "BigSmall_Big" : "BigSmall_Small";
    if (predType === "NUMBER") bc = "Num_" + String(prediction);
    if (predType === "COLOR") bc = prediction === "RED" ? "Color_Red" : "Color_Green";

    console.log(`[BET] ${bc} ₹${betMult} L${level} for Period: ${period}`);

    for (let i = 0; i < maxRetries; i++) {
        try {
            // Dynamic generation inside the loop so random/timestamp/issueNumber are fresh on retry if needed
            const params = {
                amount:      1,
                betContent:  bc,
                betMultiple: betMult,
                // COLOR formula and NUMBER use the user's 30-second game;
                // the legacy SIZE/COMBINED routes remain on WinGo_1M.
                gameCode:    (cfg.mode === "COMBINED" ? "WinGo_1M" : "WinGo_30S"),
                issueNumber: String(period),
                language:    "en",
                random:      Math.floor(Math.random() * 1e12)
            };
            const signature = makeBetSign(params);
            const timestamp = Math.floor(Date.now() / 1000);
            const payload   = {...params, signature, timestamp};

            const session = userSessions[String(userId)] || {};
            const r = await axios.post(BET_URL, payload, {
                headers: {
                    "Authorization":    "Bearer " + normalizeToken(token),
                    "authorization":    "Bearer " + normalizeToken(token),
                    "content-type":     "application/json",
                    "Accept":           "application/json, text/plain, */*",
                    "Origin":           SITE_URL,
                    "Referer":          SITE_URL,
                    "Ar-Origin":        SITE_URL,
                    ...(session.cookieHeader ? { "Cookie": session.cookieHeader } : {}),
                    "Sec-Ch-Ua":        '"Chromium";v="139"',
                    "Sec-Ch-Ua-Mobile": "?1",
                    "Sec-Fetch-Dest":   "empty",
                    "Sec-Fetch-Mode":   "cors",
                    "Sec-Fetch-Site":   "cross-site",
                    "User-Agent":       "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36"
                },
                timeout: 10000
            });
            const d = r.data || {};
            const apiMessage = String(d.msg ?? d.message ?? d.msgCode ?? "");
            console.log(`[BET RESP] game=${params.gameCode} period=${params.issueNumber} code:${d.code} msg:${apiMessage}`);

            // A bet response may rotate the token. Accept it only after bet success.
            // If no valid token is returned, keep the current token unchanged.
            const responseToken = normalizeToken(
                r.headers['authorization'] ||
                r.headers['x-auth-token'] ||
                d.data?.token ||
                d.token
            );

            // Success case
            if (d.code === 0 || d.msg === "Succeed" || d.msgCode === 0) {
                if (responseToken && responseToken.length >= 20) {
                    const updated = saveUserToken(userId, responseToken);
                    if (updated) {
                        token = responseToken;
                        console.log("[TOKEN UPDATE] Valid token saved after successful bet.");
                    } else {
                        console.warn("[TOKEN UPDATE] Token cache failed; existing token kept.");
                    }
                }
                return { ok: true, amt: betMult, bc };
            }
            if (d.code === 0 || d.msg === "Succeed" || d.msgCode === 0) {
                return { ok: true, amt: betMult, bc };
            }

            // Token Expiry Handling -> AUTOMATIC RELOGIN
            if (d.code === 401 || d.code === 40100 || d.status === 401 || isTokenExpiredMessage(apiMessage)) {
                console.log("[AUTO RELOGIN] Token expired during bet. Keeping old token until relogin succeeds...");
                const oldToken = getToken(userId);
                const freshToken = await autoLogin(userId, chatId, true);
                if (freshToken) {
                    const verifiedFreshToken = getToken(userId);
                    if (verifiedFreshToken) {
                        token = verifiedFreshToken;
                        console.log("[AUTO RELOGIN] Success! Verified new token; retrying the bet...");
                        continue;
                    }
                    token = oldToken;
                    await send(chatId, "❌ Relogin completed but no new verified token was received.");
                    return false;
                } else {
                    token = oldToken;
                    await send(chatId, "❌ Auto-login failed. Existing token was kept.");
                    return false;
                }
            }

            // Retryable errors like Param is Invalid, issue number, etc.
            const retryableErrors = ["param is invalid", "the issue number does not exist", "period current settled"];
            const lowerMsg = String(apiMessage).toLowerCase();
            
            if (retryableErrors.some(errStr => lowerMsg.includes(errStr))) {
                console.log(`[BET RETRY] Retryable error: ${d.msg}. Retrying in ${retryDelayMs / 1000}s... (Attempt ${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                continue; 
            }

            // Other unhandled API errors
            await send(chatId, "❌ Bet fail: " + (apiMessage || JSON.stringify(d).substr(0, 120)));
            return false;

        } catch (err) {
            console.error("[BET ERR]", err.message);

            // Handle Axios 401 / Token errors inside catch block
            const responseMessage = err.response?.data?.msg || err.response?.data?.message || '';
            if (err.response && (err.response.status === 401 || isTokenExpiredMessage(responseMessage))) {
                console.log("[AUTO RELOGIN] Token error caught via exception. Keeping old token until relogin succeeds...");
                const oldToken = token;
                const loginSuccess = await autoLogin(userId, chatId, true);
                if (loginSuccess) {
                    const verifiedFreshToken = getToken(userId);
                    if (verifiedFreshToken) {
                        token = verifiedFreshToken;
                        continue; // Retry after verified relogin
                    }
                    token = oldToken;
                    await send(chatId, "❌ Relogin completed but no new verified token was received.");
                    return false;
                } else {
                    token = oldToken;
                    await send(chatId, "❌ Auto-login failed. Existing token was kept.");
                    return false;
                }
            }

            // For general network errors, retry if attempts left
            if (i < maxRetries - 1) {
                console.log(`[BET RETRY] Network error. Retrying in ${retryDelayMs / 1000}s... (Attempt ${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                continue;
            }

            await send(chatId, "❌ Network error during bet: " + err.message);
            return false;
        }
    }

    console.log("[BET FAIL] All retries exhausted.");
    return false;
}
// ============================================================
// ============================================================
// COMPLETE BOT LOGIC WITH 4-PREDICTION PATTERN MODE EXTENSION & FIXES
// ============================================================
// ============================================================
// COMPLETE BOT LOGIC WITH STRICT 4-CONSECUTIVE LOSS REQUIREMENT (NO WINS ALLOWED)
// ============================================================
let userStates = {};

function getNextIssue(list) {
    const latest = (Array.isArray(list) ? list : [])
        .map(item => String(item?.issueNumber || ""))
        .find(issue => /^\d{8,}$/.test(issue));
    if (!latest) return null;
    try {
        const next = (BigInt(latest) + 1n).toString();
        return next.length === latest.length ? next : null;
    } catch {
        return null;
    }
}

function buildBSFromList(list, count = 15) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, count).reverse().map(item => {
        const n = Number.parseInt(item?.number ?? item?.winNumber ?? -1, 10);
        return n >= 5 ? "BIG" : "SMALL";
    }).filter(Boolean);
}

function initState(userId) {
    if (!userStates[userId]) userStates[userId] = { lastSitePrediction: null, resultHistory: [], mode: 'NORMAL', pastedMode: false, nextPredictionMode: 'SIZE', combinedFlipNext: false, recoveryCount: 0, winBeforeLoss: 0, lossStreak: 0, history: [], sixPredictionLock:null, activeSixChannel:null, channelLosses:{ SIZE:0, COLOR:0 }, channelSwitches:0, skipPeriodsRemaining:0, lastFiveSameIssue:null, fiveSameSkipActive:false, specialPatternSkipActive:false, lastWinPattern:null, lastWinChannel:null, lastSamePatternSwitchIssue:null };
    if (!Array.isArray(userStates[userId].resultHistory)) userStates[userId].resultHistory = [];
}

function modeLabel(mode) {
    return mode === "NUMBER" ? "NUMBER" : mode === "COLOR" ? "COLOR" : mode === "COMBINED" ? "BIG/SMALL + NUMBER" : "BIG/SMALL";
}

function getSequenceAmount(userId, level, kind = "default") {
    const cfg = autobetCfg[userId] || {};
    const seq = cfg.mode === "COMBINED" ? (kind === "number" ? cfg.customNumberBets : cfg.customSizeBets) : cfg.customBets;
    return Number(seq?.[level - 1] ?? (cfg.baseBet * (MULT[level - 1] || 1)));
}

function generateLevelTotals(amount, levels) {
    const safeAmount = Math.floor(Number(amount));
    const safeLevels = Number(levels);
    if (!Number.isFinite(safeAmount) || safeAmount <= 0 || !Number.isInteger(safeLevels) || safeLevels <= 0 || safeAmount < safeLevels) return null;
    if (safeLevels === 1) return [safeAmount];

    const reference = [47, 127, 322, 804];
    if (safeLevels === 4) {
        const totalWeight = reference.reduce((sum, value) => sum + value, 0);
        const totals = reference.map(value => Math.floor(safeAmount * value / totalWeight));
        totals[totals.length - 1] += safeAmount - totals.reduce((sum, value) => sum + value, 0);
        return totals;
    }

    const weights = Array.from({ length: safeLevels }, (_, index) => 2.5 ** index);
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const totals = weights.map(weight => Math.floor(safeAmount * weight / totalWeight));
    totals[totals.length - 1] += safeAmount - totals.reduce((sum, value) => sum + value, 0);
    return totals;
}

function createWalletPlan(walletBalance, levels) {
    const totals = generateLevelTotals(walletBalance, levels);
    if (!totals) return [];
    return totals.map((total, index) => {
        const bs = Math.round(total * 0.82);
        return { level: index + 1, bs, number: total - bs, total };
    });
}

function syncProfitPlan(userId, reason = "balance", planBalance = null, maxLevel = null) {
    const cfg = autobetCfg[userId];
    if (!cfg || !cfg.profitPlan || !cfg.profitPlan.enabled) return false;

    const plan = cfg.profitPlan;
    const walletBalance = Number(profitTrack[userId]?.walletBalance || 0);
    const configuredBalance = Math.floor(Number(planBalance ?? plan.planBalance ?? walletBalance));
    const configuredMaxLevel = Number(maxLevel ?? plan.maxLevel ?? cfg.maxLvl);
    const levels = Math.floor(configuredMaxLevel);
    if (configuredBalance <= 0 || !Number.isInteger(levels) || levels <= 0 || levels > 10 || configuredBalance < levels) return false;

    const startLevel = Math.max(1, Math.min(levels, Number(plan.startLevel) || 1));
    const walletPlan = createWalletPlan(Math.max(0, configuredBalance), levels);
    const totals = walletPlan.map(row => row.total);
    const sizeBets = walletPlan.map(row => row.bs);
    const numberBets = walletPlan.map(row => row.number);

    plan.currentLevel = startLevel;
    plan.lastReason = reason;
    plan.walletBalance = walletBalance;
    plan.planBalance = configuredBalance;
    plan.maxLevel = levels;
    plan.levels = walletPlan;
    cfg.customBets = cfg.mode === "NUMBER" ? [...numberBets] : cfg.mode === "COMBINED" ? [...totals] : [...sizeBets];
    cfg.customSizeBets = sizeBets;
    cfg.customNumberBets = numberBets;
    cfg.maxLvl = walletPlan.length;

    if (autobetState[userId] && reason !== "loss") {
        autobetState[userId].level = startLevel;
        autobetState[userId].sizeLevel = startLevel;
        autobetState[userId].numberLevel = startLevel;
    }

    return true;
}

async function refreshWalletPlan(userId, reason, planBalance = null, maxLevel = null) {
    const cfg = autobetCfg[userId];
    if (!cfg?.profitPlan?.enabled) return false;
    const balance = await getLiveBalance(userId);
    if (!balance.success) {
        console.warn(`[PLAN] Wallet refresh failed for user ${userId}: ${balance.message}`);
        return false;
    }
    return syncProfitPlan(userId, reason, balance.balance, maxLevel);
}

function getCombinedBetAmounts(userId, sizeLevel, numberLevel) {
    const cfg = autobetCfg[userId] || {};
    const maxLevel = Math.max(1, Number(cfg.maxLvl) || 1);
    const safeSizeLevel = Math.min(maxLevel, Math.max(1, Number(sizeLevel) || 1));
    const safeNumberLevel = Math.min(maxLevel, Math.max(1, Number(numberLevel) || 1));
    const base = Math.max(1, Number(cfg.baseBet) || 1);
    const sizeAmount = Number(cfg.customSizeBets?.[safeSizeLevel - 1]);
    const numberAmount = Number(cfg.customNumberBets?.[safeNumberLevel - 1]);
    return {
        size: Number.isFinite(sizeAmount) && sizeAmount > 0 ? sizeAmount : base,
        number: Number.isFinite(numberAmount) && numberAmount > 0 ? numberAmount : base,
        sizeLevel: safeSizeLevel,
        numberLevel: safeNumberLevel
    };
}

function calculateSettlement(bets, actualSize, actualNumber) {
    // Gross returns include the original stake; subtract every placed stake for net P&L.
    const normalized = Array.isArray(bets) ? bets : [];
    const totalStake = normalized.reduce((sum, bet) => sum + Math.max(0, Number(bet.amt) || 0), 0);
    let payout = 0;
    const reasons = [];

    for (const bet of normalized) {
        const amount = Math.max(0, Number(bet.amt) || 0);
        const actualColor = getActualColorBase(actualNumber);
        const won = bet.type === "SIZE"
            ? String(bet.val).toUpperCase() === String(actualSize).toUpperCase()
            : bet.type === "COLOR"
                ? String(bet.val).toUpperCase() === actualColor
                : bet.type === "NUMBER" && Number(bet.val) === Number(actualNumber);
        if (!won) continue;

        if (bet.type === "SIZE") {
            payout += amount * SIZE_WIN_MULTIPLIER;
            reasons.push("SIZE");
        } else if (bet.type === "NUMBER") {
            payout += amount * NUMBER_WIN_MULTIPLIER;
            reasons.push("NUMBER");
        } else if (bet.type === "COLOR") {
            payout += amount * SIZE_WIN_MULTIPLIER;
            reasons.push("COLOR");
        }
    }

    return {
        won: reasons.length > 0,
        pnl: payout - totalStake,
        reason: reasons.join("+") || "NONE",
        totalStake,
        payout
    };
}

function updateCombinedAfterResult(userId, sizeWon, numberWon, betPlaced) {
    initUser(userId);
    const st = autobetState[userId];
    const cfg = autobetCfg[userId] || {};
    if (!betPlaced || cfg.mode !== "COMBINED") return;
    const sizeKey = "L" + st.sizeLevel;
    const numberKey = "L" + st.numberLevel;
    st.sizeLevelHistory[sizeKey] = (st.sizeLevelHistory[sizeKey] || 0) + 1;
    st.numberLevelHistory[numberKey] = (st.numberLevelHistory[numberKey] || 0) + 1;
    const anyPredictionWon = Boolean(sizeWon || numberWon);
    if (anyPredictionWon) {
        st.lastWinLevel = st.level;
        st.lastWinMode = "COMBINED";
        st.sizeLevel = 1;
        st.numberLevel = 1;
        st.level = 1;
        st.inMart = false;
        st.consecutiveLoss = 0;
        st.lossStreakHitRecorded = false;
        st.waitingForWatchWin = false;
        st.lastOutcome = "WIN";
    } else {
        st.consecutiveLoss++;
        recordLossStreakHit(userId);
        const maxLevel = Math.max(1, Number(cfg.maxLvl) || 1);
        const currentSizeLevel = Math.min(maxLevel, Math.max(1, Number(st.sizeLevel) || 1));
        const currentNumberLevel = Math.min(maxLevel, Math.max(1, Number(st.numberLevel) || 1));
        st.sizeLevel = currentSizeLevel >= maxLevel ? 1 : currentSizeLevel + 1;
        st.numberLevel = currentNumberLevel >= maxLevel ? 1 : currentNumberLevel + 1;
        st.level = Math.max(st.sizeLevel, st.numberLevel);
        st.inMart = st.level > 1;
        // Do not place another live bet immediately after this loss.
        st.waitingForWatchWin = true;
        st.lastOutcome = "LOSS";
    }
}

function formatPrediction(signal) {
    if (!signal || signal.skip === true) return "SKIP";
    if (signal.type === "NUMBER") return String(Number(signal.val));
    if (signal.type === "SIZE") return String(signal.val || "").toUpperCase();
    if (signal.type === "COLOR") return String(signal.val || "").toUpperCase();
    if (signal.type === "COMBINED") {
        const size = String(signal.val || "").toUpperCase();
        const number = signal.number ?? signal.bets?.find(b => b.type === "NUMBER")?.val;
        return number === undefined ? size : `${size} OR ${Number(number)}`;
    }
    return "SKIP";
}

function getSide(n) {
    return Number(n) >= 5 ? 'BIG' : 'SMALL';
}

function getPredictionSelection(lastResult, historyResults) {
    const n = Number(lastResult);
    if (!Number.isInteger(n) || n < 0 || n > 9 || !Array.isArray(historyResults) || historyResults.length < 2) return null;

    const predictionSize = getSide(n);
    const oppositeSize = predictionSize === 'BIG' ? 'SMALL' : 'BIG';
    let selectedNumber = null;
    let selectedIndex = -1;

    for (let index = 1; index < historyResults.length; index++) {
        const candidate = latestResultNumber(historyResults[index]);
        if (candidate !== null && getSide(candidate) === oppositeSize) {
            selectedNumber = candidate;
            selectedIndex = index;
            break;
        }
    }

    if (selectedNumber === null) return null;

    return {
        mapping: [predictionSize, selectedNumber],
        mode: 'OPPOSITE_SIZE_MOST_RECENT',
        candidates: [selectedNumber],
        matchedApiIndex: selectedIndex,
        decisionReason: `Selected most-recent ${oppositeSize} number`
    };
}

function numberPrediction(lastResult, historyResults = []) {
    const selected = getPredictionSelection(lastResult, historyResults);
    if (!selected) return null;
    return {
        size: selected.mapping[0],
        number: selected.mapping[1],
        mode: selected.mode,
        decisionReason: selected.decisionReason
    };
}

function latestResultNumber(item) {
    const raw = item?.number ?? item?.result ?? item?.resultNumber ?? item?.num ?? item?.value ?? item?.winNumber;
    const n = Number.parseInt(String(raw ?? '').trim(), 10);
    return Number.isInteger(n) && n >= 0 && n <= 9 ? n : null;
}

function shouldSkipByThreeMatches(lastResult, historyResults) {
    const target = Number(lastResult);
    if (!Number.isInteger(target) || !Array.isArray(historyResults) || historyResults.length < 4) {
        return { skip: false, matches: [], reason: 'Not enough API history for 3-match check' };
    }

    const matches = [];
    for (let index = 1; index < historyResults.length; index++) {
        const matchNumber = latestResultNumber(historyResults[index]);
        const nextNumber = latestResultNumber(historyResults[index - 1]);
        if (matchNumber !== target || nextNumber === null) continue;

        matches.push({
            matchIssue: String(historyResults[index]?.issueNumber ?? ''),
            matchNumber,
            nextIssue: String(historyResults[index - 1]?.issueNumber ?? ''),
            nextNumber,
            nextSize: getSide(nextNumber)
        });

        if (matches.length === 3) break;
    }

    if (matches.length < 3) {
        return { skip: false, matches, reason: `Only ${matches.length} historical match(es) found; 3 required` };
    }

    const sizes = matches.map(match => match.nextSize);
    const allBig = sizes.every(size => size === 'BIG');
    const allSmall = sizes.every(size => size === 'SMALL');
    return {
        skip: allBig || allSmall,
        matches,
        reason: allBig
            ? 'Latest 3 matches all have BIG as the next result'
            : allSmall
                ? 'Latest 3 matches all have SMALL as the next result'
                : 'Latest 3 next-result sizes are mixed; prediction allowed'
    };
}

// Exact live-site ordered-pair gate. historyResults is newest first:
// [0] newest, [1] second newest, and earlier pairs are [i] -> [i - 1].
function shouldSkipByPairMatch(historyResults) {
    if (!Array.isArray(historyResults) || historyResults.length < 3) {
        return { skip: true, pair: null, found: false, reason: 'Not enough API history for 2-result pair check' };
    }

    const latestA = latestResultNumber(historyResults[1]);
    const latestB = latestResultNumber(historyResults[0]);
    if (latestA === null || latestB === null) {
        return { skip: true, pair: null, found: false, reason: 'Latest 2 results are not valid numbers' };
    }

    const pair = `${latestA}-${latestB}`;
    const historicalLimit = Math.min(historyResults.length - 1, 201);
    let found = false;
    let foundAt = null;

    for (let index = 2; index < historicalLimit; index++) {
        const older = latestResultNumber(historyResults[index]);
        const newer = latestResultNumber(historyResults[index - 1]);
        if (older === latestA && newer === latestB) {
            found = true;
            foundAt = {
                olderIssue: String(historyResults[index]?.issueNumber ?? ''),
                newerIssue: String(historyResults[index - 1]?.issueNumber ?? '')
            };
            break;
        }
    }

    return {
        skip: !found,
        pair,
        found,
        foundAt,
        searchedPairs: Math.max(0, historicalLimit - 2),
        reason: found
            ? `Pair ${pair} found in earlier 200 historical results; prediction allowed`
            : `Pair ${pair} not found in earlier 200 historical results; prediction skipped`
    };
}

function getConsecutivePairCheck(historyResults) {
    if (!Array.isArray(historyResults) || historyResults.length < 2) {
        return { consecutive: false, pair: null, reason: 'Not enough API history for consecutive pair check' };
    }

    const a = latestResultNumber(historyResults[1]);
    const b = latestResultNumber(historyResults[0]);
    if (a === null || b === null) {
        return { consecutive: false, pair: null, reason: 'Latest 2 results are not valid numbers' };
    }

    const pair = `${a}-${b}`;
    const consecutive = Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a <= 9 && b >= 0 && b <= 9 && Math.abs(a - b) === 1;

    return {
        consecutive,
        pair,
        reason: consecutive
            ? `Consecutive pair ${pair} detected`
            : `Pair ${pair} is not consecutive`
    };
}

function cfgForPredictionMode(userId) {
    return String(autobetCfg[userId]?.mode || 'SIZE').toUpperCase();
}

function getResultNumber(item) {
    const raw = item?.number ?? item?.winNumber ?? item?.result ?? item?.resultNumber;
    const n = Number.parseInt(String(raw ?? '').trim(), 10);
    return Number.isInteger(n) && n >= 0 && n <= 9 ? n : null;
}

function getSizeFromNumber(n) {
    return n >= 5 ? 'BIG' : 'SMALL';
}

function getLatestTwoPattern(list) {
    if (!Array.isArray(list) || list.length < 2) return null;
    const latestNumber = getResultNumber(list[0]);
    const previousNumber = getResultNumber(list[1]);
    if (latestNumber === null || previousNumber === null) return null;

    const latestSize = getSizeFromNumber(latestNumber);
    const previousSize = getSizeFromNumber(previousNumber);
    const pair = `${previousSize === 'BIG' ? 'B' : 'S'}${latestSize === 'BIG' ? 'B' : 'S'}`;
    const isSame = latestSize === previousSize;

    return {
        latestNumber,
        previousNumber,
        latestSize,
        previousSize,
        pair,
        rule: isSame ? 'SAME' : 'OPPOSITE',
        prediction: isSame ? latestSize : (latestSize === 'BIG' ? 'SMALL' : 'BIG')
    };
}

function calculatePastedRecoveryPrediction(list, currentResult) {
    const currentPeriod = String(list[0]?.issueNumber ?? list[0]?.issue ?? '');
    if (!/^\d+$/.test(currentPeriod) || !Number.isInteger(currentResult) || currentResult === 0) {
        return null;
    }

    let nextPeriod;
    try {
        nextPeriod = (BigInt(currentPeriod) + 1n).toString();
    } catch (_) {
        return null;
    }

    const nextLast3Num = Number.parseInt(nextPeriod.slice(-3), 10);
    const answer = nextLast3Num * Math.exp(currentResult);
    const noDecimal = String(answer).replace('.', '');
    const first14 = noDecimal.substring(0, 14);
    const lastDigit = Number.parseInt(first14.charAt(first14.length - 1), 10);
    if (!Number.isInteger(lastDigit)) return null;

    return {
        prediction: lastDigit >= 5 ? 'BIG' : 'SMALL',
        lastDigit,
        nextLast3Num,
        reason: `${nextLast3Num} × exp(${currentResult}) -> ${lastDigit}`
    };
}

function getBigSmallPatternPrediction(list) {
    if (!Array.isArray(list) || list.length < 2) return null;

    // API order is newest first. Use only the latest five periods.
    const sizes = list.slice(0, 5).map(item => {
        const n = getResultNumber(item);
        return n === null ? null : getSizeFromNumber(n);
    });
    if (sizes.length < 2 || sizes.some(size => !size)) return null;

    const latest = sizes[0];
    const second = sizes[1];
    const last2Same = latest === second;
    const last2Rule = last2Same ? 'OPPOSITE' : 'SAME';

    // First rule: latest two same => opposite; latest two different => same/latest.
    let prediction = last2Same
        ? (latest === 'BIG' ? 'SMALL' : 'BIG')
        : latest;

    const last4 = sizes.slice(0, Math.min(4, sizes.length));
    const big4 = last4.filter(size => size === 'BIG').length;
    const small4 = last4.length - big4;
    const all4Same = big4 === 4 || small4 === 4;

    // Second rule: verify the latest four. A same run is changed to its
    // opposite; a mixed four uses the clear majority.
    let last4Rule;
    if (all4Same) {
        prediction = last4[0] === 'BIG' ? 'SMALL' : 'BIG';
        last4Rule = 'ALL_4_SAME_OPPOSITE';
    } else if (big4 >= 3 || small4 >= 3) {
        prediction = big4 >= 3 ? 'BIG' : 'SMALL';
        last4Rule = '4_PERIOD_MAJORITY';
    } else {
        last4Rule = '4_PERIOD_MIXED_KEEP_LAST2_RULE';
    }

    return {
        prediction,
        sizes,
        last2: `${second === 'BIG' ? 'B' : 'S'}${latest === 'BIG' ? 'B' : 'S'}`,
        last2Rule,
        last4: last4.map(size => size === 'BIG' ? 'B' : 'S').join(''),
        last4Rule,
        reason: `Last5=${sizes.map(size => size === 'BIG' ? 'B' : 'S').join('')} | Last2=${last2Rule} | Last4=${last4Rule}`
    };
}

function analyzeSameOppositeHistory(historyList, fallbackPattern) {
    const sizes = (Array.isArray(historyList) ? historyList : []).map(item => {
        const n = getResultNumber(item);
        return n === null ? null : getSizeFromNumber(n);
    }).filter(Boolean);

    const windows = [20, 50, 100, 200];
    const weights = [0.40, 0.30, 0.20, 0.10];
    const reports = [];
    let weightedSame = 0;
    let weightedOpposite = 0;
    let totalWeight = 0;

    for (let w = 0; w < windows.length; w++) {
        const count = Math.min(windows[w], sizes.length);
        if (count < 2) continue;
        let sameWins = 0;
        let oppositeWins = 0;
        for (let i = 0; i < count - 1; i++) {
            const previous = sizes[i + 1];
            const actual = sizes[i];
            if (previous === actual) sameWins++;
            else oppositeWins++;
        }
        const samples = count - 1;
        const sameRate = sameWins / samples;
        const oppositeRate = oppositeWins / samples;
        const weight = weights[w];
        weightedSame += sameRate * weight;
        weightedOpposite += oppositeRate * weight;
        totalWeight += weight;
        reports.push({ window: windows[w], samples, sameWins, oppositeWins,
            sameRate: Math.round(sameRate * 100), oppositeRate: Math.round(oppositeRate * 100),
            winner: sameRate === oppositeRate ? 'TIE' : sameRate > oppositeRate ? 'SAME' : 'OPPOSITE' });
    }

    if (!totalWeight) {
        return { mode: fallbackPattern?.last2Rule === 'OPPOSITE' ? 'OPPOSITE' : 'SAME',
            action: 'WAIT', confidence: 50, samples: 0, reports: [],
            reason: 'Not enough Lucifer history for a reliable mode analysis' };
    }
    weightedSame /= totalWeight;
    weightedOpposite /= totalWeight;
    const margin = Math.abs(weightedSame - weightedOpposite);
    const sameVotes = reports.filter(r => r.winner === 'SAME').length;
    const oppositeVotes = reports.filter(r => r.winner === 'OPPOSITE').length;
    const mode = weightedSame > weightedOpposite ? 'SAME' : 'OPPOSITE';

    // Require strict 90% empirical confidence and multi-window agreement.
    // Otherwise the safest behavior is WAIT rather than forcing a bet.
    const agreement = Math.max(sameVotes, oppositeVotes);
    const confidence = Math.max(50, Math.min(95, Math.round((0.5 + margin) * 100)));
    const clearEdge = confidence >= 90 && agreement >= 2;
    const action = clearEdge ? 'BET' : 'WAIT';
    const compact = reports.map(r => `${r.window}:${r.winner}`).join(' ');
    return {
        mode, action, confidence, samples: reports[reports.length - 1]?.samples || 0,
        sameRate: Math.round(weightedSame * 100),
        oppositeRate: Math.round(weightedOpposite * 100),
        reports,
        reason: `Weighted SAME ${Math.round(weightedSame * 100)}% vs OPPOSITE ${Math.round(weightedOpposite * 100)}% | Windows ${compact} | Agreement ${agreement}/4 | Action ${action}`
    };
}

/* ============================================================
   SIX-RESULT OPPOSITE PATTERN PREDICTOR
   - Uses Lucifer root history (newest first).
   - Exactly 6 latest results are analyzed.
   - 4B/2S or 4S/2B: requires a visible double pattern (BB/SS).
     The prediction is the opposite side of the strongest/recent double.
   - 3B/3S: requires a strict zigzag (BSBSBS or SBSBSB).
     The prediction is the opposite of the normal zigzag continuation.
   - Any other shape is WAIT/SKIP.
   - A signal is locked after dispatch and is kept after losses until WIN.
   This is a heuristic only; it cannot guarantee a win.
============================================================ */
function sixPatternSide(value) {
    const n = getResultNumber(value);
    return n === null ? null : (n >= 5 ? 'B' : 'S');
}

function sixPatternColor(value) {
    const n = getResultNumber(value);
    if (n === null) return null;
    if (n === 0 || n === 2 || n === 4 || n === 6 || n === 8) return 'R';
    return 'G';
}

function oppositeSixSide(side) {
    return side === 'B' ? 'SMALL' : 'BIG';
}

function analyzeSixResultOppositePattern(history) {
    const rows = Array.isArray(history) ? history : [];
    const latestSix = rows.slice(0, 6);
    if (latestSix.length < 6) {
        return { skip: true, reason: 'Need 6 valid Lucifer results', pattern: '' };
    }

    const sizes = latestSix.map(sixPatternSide);
    const colors = latestSix.map(sixPatternColor);
    if (sizes.some(v => !v) || colors.some(v => !v)) {
        return { skip: true, reason: 'Latest 6 Lucifer results contain invalid values', pattern: '' };
    }

    const bigCount = sizes.filter(v => v === 'B').length;
    const smallCount = sizes.filter(v => v === 'S').length;
    const sizePattern = sizes.join('');
    const colorPattern = colors.join('');
    const colorRuns = colors.filter((v, i) => i === 0 || v !== colors[i - 1]).length;

    // Only accept the requested 4/2 shape when a double is visibly present.
    if ((bigCount === 4 && smallCount === 2) || (bigCount === 2 && smallCount === 4)) {
        const doublePositions = [];
        for (let i = 0; i < sizes.length - 1; i++) {
            if (sizes[i] === sizes[i + 1]) {
                doublePositions.push({ side: sizes[i], index: i });
            }
        }
        if (!doublePositions.length) {
            return {
                skip: true,
                reason: `4/2 count found (${bigCount}B ${smallCount}S), but no visible BB/SS double pattern`,
                pattern: sizePattern,
                colorPattern,
                bigCount,
                smallCount
            };
        }

        // Prefer the most frequent double side; break ties by newest occurrence.
        const doubleCounts = doublePositions.reduce((out, item) => {
            out[item.side] = (out[item.side] || 0) + 1;
            return out;
        }, {});
        const doubleSide = ['B', 'S'].sort((a, b) =>
            (doubleCounts[b] || 0) - (doubleCounts[a] || 0) ||
            doublePositions.find(x => x.side === a).index - doublePositions.find(x => x.side === b).index
        )[0];

        return {
            skip: false,
            type: 'SIZE',
            val: oppositeSixSide(doubleSide),
            pattern: sizePattern,
            colorPattern,
            rule: '4/2_DOUBLE_OPPOSITE',
            bigCount,
            smallCount,
            doubleSide,
            doublePattern: doubleSide + doubleSide,
            conf: 50,
            historyBased: true,
            mode: 'SIX-RESULT OPPOSITE',
            pat: 'DOUBLE-OPPOSITE',
            decisionReason: `${sizePattern}: ${bigCount}B/${smallCount}S; ${doubleSide + doubleSide} double -> opposite ${oppositeSixSide(doubleSide)}`,
            bets: [{ type: 'SIZE', val: oppositeSixSide(doubleSide), kind: 'size' }]
        };
    }

    // Strict zigzag only; mixed 3/3 shapes are intentionally skipped.
    const isZigzag = sizes.every((v, i) => i === 0 || v !== sizes[i - 1]);
    if (bigCount === 3 && smallCount === 3 && isZigzag) {
        const latestSide = sizes[0];
        const normalContinuation = latestSide === 'B' ? 'S' : 'B';
        const oppositePrediction = oppositeSixSide(normalContinuation);
        return {
            skip: false,
            type: 'SIZE',
            val: oppositePrediction,
            pattern: sizePattern,
            colorPattern,
            rule: '3/3_ZIGZAG_OPPOSITE',
            bigCount,
            smallCount,
            normalContinuation: oppositeSixSide(latestSide),
            conf: 50,
            historyBased: true,
            mode: 'SIX-RESULT OPPOSITE',
            pat: 'ZIGZAG-OPPOSITE',
            decisionReason: `${sizePattern}: strict 3B/3S zigzag; normal ${oppositeSixSide(latestSide)} -> opposite ${oppositePrediction}`,
            bets: [{ type: 'SIZE', val: oppositePrediction, kind: 'size' }]
        };
    }

    return {
        skip: true,
        reason: `No requested pattern: ${sizePattern} (${bigCount}B/${smallCount}S); color=${colorPattern}`,
        pattern: sizePattern,
        colorPattern,
        bigCount,
        smallCount,
        colorRuns
    };
}

function getLockedSixPrediction(userId) {
    initState(userId);
    const lock = userStates[userId].sixPredictionLock;
    return lock && lock.type && lock.val ? lock : null;
}

function setLockedSixPrediction(userId, signal, sourceIssue) {
    initState(userId);
    userStates[userId].sixPredictionLock = {
        type: signal.type,
        channel: signal.channel || signal.type,
        val: signal.val,
        pattern: signal.pattern,
        colorPattern: signal.colorPattern,
        rule: signal.rule,
        sourceIssue: String(sourceIssue || ''),
        losses: Number(userStates[userId].sixPredictionLock?.losses || 0)
    };
}

function clearLockedSixPrediction(userId) {
    initState(userId);
    userStates[userId].sixPredictionLock = null;
}

function sixChannelToken(row, channel) {
    return channel === 'COLOR' ? sixPatternColor(row) : sixPatternSide(row);
}

function sixChannelPredictionValue(token, channel) {
    if (channel === 'COLOR') return token === 'R' ? 'GREEN' : 'RED';
    return oppositeSixSide(token);
}

function sixChannelValueFromToken(token, channel) {
    if (channel === 'COLOR') return token === 'R' ? 'RED' : 'GREEN';
    return token === 'B' ? 'BIG' : 'SMALL';
}

function isSpecialSixPattern(pattern) {
    const normalized = String(pattern || '').toUpperCase().replace(/[RG]/g, value => value === 'R' ? 'B' : 'S');
    return new Set(['BBSSBB', 'BSBSBS', 'SSBBSS', 'SBSBSB', 'BBBSSS', 'SSSBBB']).has(normalized);
}

function classifyRecentSixPattern(values) {
    const tokens = Array.isArray(values) ? values : [];
    if (tokens.length !== 6 || tokens.some(value => !value)) return { kind: 'OTHER', pattern: tokens.join('') };
    const first = tokens[0];
    const opposite = first === 'B' || first === 'R' ? (first === 'B' ? 'S' : 'G') : (first === 'S' ? 'B' : 'R');
    const countFirst = tokens.filter(value => value === first).length;
    const countSecond = tokens.length - countFirst;
    if ((countFirst === 4 && countSecond === 2) || (countFirst === 2 && countSecond === 4)) {
        return { kind: 'DOUBLE', pattern: first + first + opposite + opposite + first + first };
    }
    const zigzag = tokens.every((value, index) => index === 0 || value !== tokens[index - 1]);
    if (countFirst === 3 && countSecond === 3 && zigzag) {
        return { kind: 'ZIGZAG', pattern: Array.from({ length: 6 }, (_, i) => i % 2 === 0 ? first : opposite).join('') };
    }
    return { kind: 'OTHER', pattern: tokens.join('') };
}

function buildSixChannelSignal(history, channel) {
    const rows = Array.isArray(history) ? history.slice(0, 6) : [];
    const current = rows[0];
    const currentToken = current ? sixChannelToken(current, channel) : null;
    if (!currentToken) {
        return { skip: true, reason: `Current ${channel} result unavailable`, channel };
    }

    // User rule: never skip a valid result. Always predict the opposite of the
    // current/latest result. The six-result pattern is retained as metadata.
    const oppositeValue = sixChannelPredictionValue(currentToken, channel);
    const base = {
        skip: false,
        channel,
        type: channel === 'COLOR' ? 'COLOR' : 'SIZE',
        val: oppositeValue,
        pattern: '',
        colorPattern: '',
        conf: 50,
        historyBased: true,
        mode: `${channel} CURRENT OPPOSITE`,
        pat: `${channel}-CURRENT-OPPOSITE`,
        decisionReason: `${channel} current ${currentToken} -> opposite ${oppositeValue}`,
        bets: [{ type: channel === 'COLOR' ? 'COLOR' : 'SIZE', val: oppositeValue, kind: channel.toLowerCase() }]
    };

    if (rows.length < 6) {
        base.pattern = rows.map(row => sixChannelToken(row, channel) || '?').join('');
        base.rule = 'CURRENT_OPPOSITE_NO_SIX_HISTORY';
        base.decisionReason += ' | fewer than 6 history rows';
        return base;
    }

    const values = rows.map(row => sixChannelToken(row, channel));
    if (values.some(value => !value)) {
        base.pattern = values.map(value => value || '?').join('');
        base.rule = 'CURRENT_OPPOSITE_INVALID_HISTORY';
        base.decisionReason += ' | invalid older history ignored';
        return base;
    }

    const first = values[0];
    const countFirst = values.filter(value => value === first).length;
    const countSecond = values.length - countFirst;
    const rawPattern = values.join('');
    const doubles = [];
    for (let i = 0; i < values.length - 1; i++) {
        if (values[i] === values[i + 1]) doubles.push(values[i]);
    }
    const zigzag = values.every((value, index) => index === 0 || value !== values[index - 1]);
    const recentClass = classifyRecentSixPattern(values);
    const pattern = rawPattern;

    base.rawPattern = rawPattern;
    base.recentPattern = recentClass.pattern;
    base.pattern = pattern;
    base.countFirst = countFirst;
    base.countSecond = countSecond;
    if ((countFirst === 4 && countSecond === 2) || (countFirst === 2 && countSecond === 4)) {
        // 4/2 double pattern: predict the majority side. Example BBBBSS -> BIG.
        const majorityToken = countFirst > countSecond ? first : values.find(value => value !== first);
        base.val = sixChannelValueFromToken(majorityToken, channel);
        base.bets = [{ type: channel === 'COLOR' ? 'COLOR' : 'SIZE', val: base.val, kind: channel.toLowerCase() }];
        base.rule = '4/2_DOUBLE_MAJORITY';
        base.pat = `${channel}-DOUBLE-${recentClass.pattern}`;
        base.decisionReason = `${channel} latest6 ${pattern} -> recent double ${recentClass.pattern}; majority ${majorityToken} -> ${base.val}`;
    } else if (countFirst === 3 && countSecond === 3 && zigzag) {
        base.rule = '3/3_ZIGZAG_CURRENT_OPPOSITE';
        base.pat = `${channel}-ZIGZAG-${recentClass.pattern}-OPPOSITE`;
    } else {
        base.rule = 'CURRENT_OPPOSITE_PATTERN_OTHER';
        base.pat = `${channel}-CURRENT-OPPOSITE`;
    }
    base.decisionReason += ` | latest6 ${pattern}; ${base.rule}; no-skip mode`;
    return base;
}

function backtestSixChannel(history, channel) {
    const rows = Array.isArray(history) ? history : [];
    let tested = 0, wins = 0, losses = 0;
    const limit = rows.length - 6;
    for (let index = 1; index < limit; index++) {
        const signal = buildSixChannelSignal(rows.slice(index, index + 6), channel);
        if (signal.skip) continue;
        const actualToken = sixChannelToken(rows[index - 1], channel);
        const predictedToken = channel === 'COLOR'
            ? (signal.val === 'RED' ? 'R' : 'G')
            : (signal.val === 'BIG' ? 'B' : 'S');
        tested++;
        if (actualToken === predictedToken) wins++;
        else losses++;
    }
    return { channel, tested, wins, losses, winRate: tested ? wins / tested : 0, lossRate: tested ? losses / tested : 1 };
}

function chooseSixChannel(history, currentHistory) {
    const candidates = ['SIZE', 'COLOR'].map(channel => ({
        channel,
        signal: buildSixChannelSignal(currentHistory, channel),
        report: backtestSixChannel(history, channel)
    }));
    const usable = candidates.filter(item => !item.signal.skip);
    if (!usable.length) return { signal: { skip: true, reason: 'Neither SIZE nor COLOR has a requested visible pattern' }, reports: candidates.map(item => item.report) };
    usable.sort((a, b) => b.report.winRate - a.report.winRate || a.report.losses - b.report.losses || b.report.tested - a.report.tested);
    const selected = usable[0];
    selected.signal.historicalTested = selected.report.tested;
    selected.signal.historicalWins = selected.report.wins;
    selected.signal.historicalLosses = selected.report.losses;
    selected.signal.historicalWinRate = Math.round(selected.report.winRate * 100);
    selected.signal.decisionReason += ` | selected ${selected.channel}; SIZE ${candidates[0].report.wins}/${candidates[0].report.tested}, COLOR ${candidates[1].report.wins}/${candidates[1].report.tested}`;
    return { signal: selected.signal, reports: candidates.map(item => item.report) };
}

// Exact predictor ported from uploaded 3.html.
const WHIMSICAL_MAP = Object.freeze({
    STREAK: 'SBS', BALANCE: 'SBB', ALTERNATION: 'BBB',
    TRANSITION: 'BSS', REPEAT: 'SBS', GAP: 'BSB', WEIGHTED: 'SBB'
});
const WHIMSICAL_MODES = Object.freeze(['STREAK', 'BALANCE', 'ALTERNATION', 'TRANSITION', 'REPEAT', 'GAP', 'WEIGHTED']);

function whimsicalSize(n) {
    return Number(n) >= 5 ? 'BIG' : 'SMALL';
}
function whimsicalTransition(nums) {
    const counts = Array(10).fill(0);
    const current = nums[0];
    for (let i = 0; i < nums.length - 1; i++) if (nums[i] === current) counts[nums[i + 1]]++;
    const total = counts.reduce((a, b) => a + b, 0);
    return total ? (counts.slice(5).reduce((a, b) => a + b, 0) / total >= 0.5 ? 'BIG' : 'SMALL') : whimsicalSize(current);
}
function whimsicalGap(nums) {
    const gaps = [];
    for (let n = 0; n < 10; n++) {
        const index = nums.indexOf(n);
        gaps.push([index < 0 ? nums.length : index, n]);
    }
    const maxGap = Math.max(...gaps.map(item => item[0]));
    const candidates = gaps.filter(item => item[0] >= maxGap * 0.75).sort((a, b) => b[0] - a[0]);
    return whimsicalSize(candidates[0]?.[1] ?? nums[0]);
}
function whimsicalWeighted(nums) {
    const sizes = nums.map(whimsicalSize);
    let streak = 1;
    for (let i = 1; i < Math.min(8, sizes.length); i++) {
        if (sizes[i] === sizes[0]) streak++;
        else break;
    }
    const bigCount = sizes.slice(0, 10).filter(x => x === 'BIG').length;
    const smallCount = 10 - bigCount;
    const alternation = sizes.length < 2 ? 0 : sizes.slice(0, 12).reduce((v, x, i, a) => i && x !== a[i - 1] ? v + 1 : v, 0) / (Math.min(12, sizes.length) - 1 || 1);
    let big = 0.5, small = 0.5;
    const add = (side, amount) => { if (side === 'BIG') big += amount; else small += amount; };
    const sub = (side, amount) => { if (side === 'BIG') big -= amount; else small -= amount; };
    if (streak >= 4) { const side = sizes[0] === 'BIG' ? 'SMALL' : 'BIG'; add(side, .32); sub(sizes[0], .32); }
    else if (streak >= 3) { const side = sizes[0] === 'BIG' ? 'SMALL' : 'BIG'; add(side, .22); sub(sizes[0], .22); }
    else if (streak >= 2) { const side = sizes[0] === 'BIG' ? 'SMALL' : 'BIG'; add(side, .1); sub(sizes[0], .1); }
    if (bigCount >= 8) { add('SMALL', .26); sub('BIG', .26); }
    else if (bigCount >= 7) { add('SMALL', .18); sub('BIG', .18); }
    else if (bigCount >= 6) { add('SMALL', .08); sub('BIG', .08); }
    if (smallCount >= 8) { add('BIG', .26); sub('SMALL', .26); }
    else if (smallCount >= 7) { add('BIG', .18); sub('SMALL', .18); }
    else if (smallCount >= 6) { add('BIG', .08); sub('SMALL', .08); }
    if (alternation > .72) { const side = sizes[0] === 'BIG' ? 'SMALL' : 'BIG'; add(side, .2); sub(sizes[0], .2); }
    else if (alternation < .28) { add(sizes[0], .12); sub(sizes[0] === 'BIG' ? 'SMALL' : 'BIG', .12); }
    return big >= small ? 'BIG' : 'SMALL';
}
function whimsicalContext(nums) {
    const sizes = nums.map(whimsicalSize);
    let streak = 1;
    for (let i = 1; i < Math.min(8, sizes.length); i++) { if (sizes[i] === sizes[0]) streak++; else break; }
    const bigCount = sizes.slice(0, 10).filter(x => x === 'BIG').length;
    const alternation = sizes.length < 2 ? 0 : sizes.slice(0, 12).reduce((v, x, i, a) => i && x !== a[i - 1] ? v + 1 : v, 0) / (Math.min(12, sizes.length) - 1 || 1);
    const out = {};
    out.STREAK = streak >= 2 ? (sizes[0] === 'BIG' ? 'SMALL' : 'BIG') : sizes[0];
    out.BALANCE = Math.abs(bigCount - (10 - bigCount)) >= 2 ? (bigCount > 10 - bigCount ? 'SMALL' : 'BIG') : sizes[0];
    out.ALTERNATION = alternation > .72 ? (sizes[0] === 'BIG' ? 'SMALL' : 'BIG') : alternation < .28 ? sizes[0] : (bigCount >= 10 - bigCount ? 'BIG' : 'SMALL');
    out.TRANSITION = whimsicalTransition(nums);
    const key = nums.slice(0, 3).join(',');
    let found = null;
    for (let i = 3; i < nums.length - 3; i++) if (nums.slice(i, i + 3).join(',') === key) { found = nums[i - 1]; break; }
    out.REPEAT = found === null ? sizes[0] : whimsicalSize(found);
    out.GAP = whimsicalGap(nums);
    out.WEIGHTED = whimsicalWeighted(nums);
    return out;
}
function calculatePastedModePrediction(list, state = {}) {
    if (!Array.isArray(list) || !list[0]) return null;
    const nums = list.slice(0, 100).map(item => Number(item?.number)).filter(n => Number.isInteger(n) && n >= 0 && n <= 9);
    if (!nums.length) return null;
    const period = String(list[0].issueNumber ?? list[0].issue ?? '');
    if (!/^\d+$/.test(period)) return null;
    const nextPeriod = (() => { try { return (BigInt(period) + 1n).toString(); } catch (_) { return null; } })();
    if (!nextPeriod) return null;
    const context = whimsicalContext(nums);
    const pattern = nums.slice(0, 3).map(whimsicalSize).map(x => x[0]).join('');
    const active = WHIMSICAL_MODES.filter(mode => WHIMSICAL_MAP[mode] === pattern);
    const votes = active.map(mode => context[mode]);
    const bigVotes = votes.filter(value => value === 'BIG').length;
    const smallVotes = votes.length - bigVotes;
    if (!active.length || bigVotes === smallVotes) {
        return {
            skip: true,
            source: 'WHIMSICAL_HTML',
            period: nextPeriod,
            reason: active.length ? `WAIT: tie ${bigVotes}-${smallVotes} for pattern ${pattern}` : `WAIT: no best-pattern mode match for ${pattern}`
        };
    }
    const pick = bigVotes > smallVotes ? 'BIG' : 'SMALL';
    return {
        skip: false,
        source: 'WHIMSICAL_HTML',
        externalPatternSignal: true,
        type: 'SIZE',
        val: pick,
        mode: 'BIG/SMALL',
        pat: 'FULL-HISTORY-BEST-PATTERNS',
        pattern,
        period: nextPeriod,
        activeModes: active,
        bigVotes,
        smallVotes,
        conf: Math.round(Math.max(bigVotes, smallVotes) / active.length * 100),
        decisionReason: `${active.length} mode(s) matched ${pattern}; BIG ${bigVotes}, SMALL ${smallVotes}`,
        bets: [{ type: 'SIZE', val: pick, kind: 'size' }]
    };
}
function inspectFiveSameRule(history) {
    const rows = Array.isArray(history) ? history.slice(0, 6) : [];
    if (rows.length < 6) return { ready: false, sizeFive: false, colorFive: false, issue: '' };
    const sizeValues = rows.map(row => sixPatternSide(row));
    const colorValues = rows.map(row => sixPatternColor(row));
    const countAtLeastFive = values => {
        if (values.some(value => !value)) return false;
        return Math.max(...[...new Set(values)].map(value => values.filter(item => item === value).length)) >= 5;
    };
    return {
        ready: true,
        sizeFive: countAtLeastFive(sizeValues),
        colorFive: countAtLeastFive(colorValues),
        sizePattern: sizeValues.join(''),
        colorPattern: colorValues.join(''),
        issue: String(rows[0]?.issueNumber || rows[0]?.issue || '')
    };
}

function calculateDifferenceSizePrediction(list, state = {}) {
    if (!Array.isArray(list) || list.length < 2 || !list[0] || !list[1]) return null;
    const currentPeriod = String(list[0].issueNumber ?? list[0].issue ?? '');
    const currentNumber = Number.parseInt(list[0].number ?? list[0].winNumber ?? '', 10);
    const previousNumber = Number.parseInt(list[1].number ?? list[1].winNumber ?? '', 10);
    if (!/^\d+$/.test(currentPeriod) || !Number.isInteger(currentNumber) || !Number.isInteger(previousNumber) || currentNumber < 0 || currentNumber > 9 || previousNumber < 0 || previousNumber > 9) return null;
    let nextPeriod;
    try { nextPeriod = (BigInt(currentPeriod) + 1n).toString(); } catch (_) { return null; }

    // Compare period 000/current against period 001/previous:
    // current < previous => SMALL; current > previous => BIG;
    // equal numbers use the same number's own BIG/SMALL side.
    const analysis = currentNumber < previousNumber ? 'SMALL'
        : currentNumber > previousNumber ? 'BIG'
        : currentNumber >= 5 ? 'BIG' : 'SMALL';
    const oppositeActive = state.sizeOppositeActive === true || state.sizePredictionMode === 'OPPOSITE' || state.mode === 'OPPOSITE';
    const mode = oppositeActive ? 'OPPOSITE' : 'ANALYSIS';
    // Always invert the already-calculated analysis value, never recalculate
    // the comparison in recovery/opposite mode.
    const prediction = oppositeActive ? (analysis === 'SMALL' ? 'BIG' : 'SMALL') : analysis;
    return {
        type: 'SIZE',
        val: prediction,
        mode,
        pat: `TWO-RESULT-DIFFERENCE-${mode}`,
        source: 'TWO_RESULT_COMPARISON',
        conf: 90,
        currentPeriod,
        currentNumber,
        previousNumber,
        nextPeriod,
        analysis,
        comparison: currentNumber === previousNumber ? 'EQUAL' : currentNumber < previousNumber ? 'CURRENT_LT_PREVIOUS' : 'CURRENT_GT_PREVIOUS',
        bets: [{ type: 'SIZE', val: prediction, kind: 'size' }]
    };
}

function calculateFormulaChannelPrediction(list, state = {}) {
    if (!Array.isArray(list) || list.length < 2 || !list[0]) return null;

    const currentPeriod = String(list[0].issueNumber ?? list[0].issue ?? '');
    const currentResult = Number.parseInt(list[0].number ?? list[0].winNumber ?? '', 10);
    if (!/^\d+$/.test(currentPeriod) || !Number.isInteger(currentResult) || currentResult < 0 || currentResult > 9) return null;

    let nextPeriod;
    try { nextPeriod = (BigInt(currentPeriod) + 1n).toString(); }
    catch (_) { return null; }

    const nextLast3Num = Number.parseInt(nextPeriod.slice(-3), 10);
    if (!Number.isFinite(nextLast3Num)) return null;
    const answer = nextLast3Num * Math.exp(currentResult);
    const noDecimal = String(answer).replace('.', '');
    const first14 = noDecimal.substring(0, 14);
    const lastDigit = Number.parseInt(first14.charAt(first14.length - 1), 10);
    if (!Number.isInteger(lastDigit) || lastDigit < 0 || lastDigit > 9) return null;

    const channel = state.activeChannel === 'SIZE' ? 'SIZE' : 'COLOR';
    const mode = state.mode === 'RECOVERY' ? 'RECOVERY' : 'NORMAL';
    let prediction;
    let type;
    if (channel === 'SIZE') {
        prediction = lastDigit <= 4 ? 'SMALL' : 'BIG';
        type = 'SIZE';
    } else {
        prediction = lastDigit % 2 === 0 ? 'RED' : 'GREEN';
        type = 'COLOR';
    }
    // Recovery uses the opposite output for the active channel.
    if (mode === 'RECOVERY') {
        prediction = channel === 'SIZE'
            ? (prediction === 'SMALL' ? 'BIG' : 'SMALL')
            : (prediction === 'RED' ? 'GREEN' : 'RED');
    }

    return {
        type,
        val: prediction,
        mode,
        channel,
        pat: `FORMULA-${channel}-${mode}`,
        source: 'FORMULA_LAST_DIGIT_CHANNEL',
        conf: 90,
        currentPeriod,
        currentResult,
        nextPeriod,
        calculatedAnswer: answer,
        lastDigit,
        colorRule: 'EVEN=RED, ODD=GREEN',
        sizeRule: '0-4=SMALL, 5-9=BIG',
        bets: [{ type, val: prediction, kind: type === 'COLOR' ? 'color' : 'size' }]
    };
}

// Backward-compatible name for any internal callers.
function calculateFormulaColorPrediction(list, state = {}) {
    return calculateFormulaChannelPrediction(list, { ...state, activeChannel: 'COLOR' });
}
function decidePrediction(list, currentLevel, userId) {
    if (!Array.isArray(list) || list.length < 2) return null;
    initState(userId);
    const state = userStates[userId];
    const cfg = autobetCfg[userId] || {};
    if (cfg.mode === 'SIZE' && state.sizeOppositeActive !== true) state.sizePredictionMode = 'ANALYSIS';
    state.pastedMode = false;
    if (cfg.mode === 'SIZE') {
        if (state.sizeOppositeActive !== true) state.sizePredictionMode = 'ANALYSIS';
        state.mode = 'NORMAL';
        state.activeChannel = 'SIZE';
        state.nextPredictionMode = state.sizeOppositeActive ? 'OPPOSITE' : 'ANALYSIS';
        state.activeSixChannel = 'SIZE';
        const signal = calculateDifferenceSizePrediction(list, state);
        if (signal) {
            state.lastPredictionChannel = 'SIZE';
            state.lastPredictionMode = signal.mode;
            state.sizePredictionMode = signal.mode;
            state.sizeOppositeActive = signal.mode === 'OPPOSITE';
            state.lastPredictionValue = signal.val;
        }
        return signal;
    }
    if (state.activeChannel !== 'SIZE' && state.activeChannel !== 'COLOR') state.activeChannel = 'COLOR';
    if (state.mode !== 'RECOVERY') state.mode = 'NORMAL';
    state.nextPredictionMode = state.activeChannel;
    state.activeSixChannel = state.activeChannel;
    const signal = calculateFormulaChannelPrediction(list, state);
    if (signal) {
        state.lastPredictionChannel = signal.channel;
        state.lastPredictionMode = signal.mode;
        state.lastPredictionValue = signal.val;
    }
    return signal;
}
function recordLossStreakHit(userId) {
    const st = autobetState[userId];
    const cfg = autobetCfg[userId] || {};
    const pt = profitTrack[userId];
    const threshold = Math.max(1, Number(cfg.watchLoss) || 1);
    if (st.consecutiveLoss >= threshold && !st.lossStreakHitRecorded) {
        pt.lossStreakHits = (pt.lossStreakHits || 0) + 1;
        st.lossStreakHitRecorded = true;
    }
}

function getModeFromHistory(state) {
    return state.mode === 'RECOVERY' ? 'RECOVERY' : 'NORMAL';
}

function updateAfterResult(userId, wasWin, actual, betPlaced) {
    initUser(userId);
    initState(userId);
    const state = userStates[userId];
    if (!Array.isArray(state.history)) state.history = [];
    state.history.push(wasWin ? 'W' : 'L');
    if (state.history.length > 20) state.history.shift();

    // Do not change prediction mode after WIN or LOSS. The next period's
    // history selector chooses its own SIZE/COLOUR signal.
    state.pastedMode = false;
    if (!state.channelLosses || typeof state.channelLosses !== 'object') state.channelLosses = { SIZE: 0, COLOR: 0 };
    const activeChannel = state.activeSixChannel === 'COLOR' ? 'COLOR' : 'SIZE';
    if (wasWin) {
        const winningLock = state.sixPredictionLock;
        state.lastWinPattern = winningLock?.pattern || null;
        state.lastWinChannel = winningLock?.channel || activeChannel;
        state.lastSamePatternSwitchIssue = null;
        state.channelLosses[activeChannel] = 0;
        state.activeSixChannel = null;
        state.skipPeriodsRemaining = 0;
        state.lastFiveSameIssue = null;
        state.fiveSameSkipActive = false;
        state.specialPatternSkipActive = false;
        clearLockedSixPrediction(userId);
    } else {
        state.channelLosses[activeChannel] = Number(state.channelLosses[activeChannel] || 0) + 1;
        if (state.sixPredictionLock) state.sixPredictionLock.losses = Number(state.sixPredictionLock.losses || 0) + 1;
        if (state.channelLosses[activeChannel] >= 5) {
            state.activeSixChannel = activeChannel === 'SIZE' ? 'COLOR' : 'SIZE';
            state.channelLosses[state.activeSixChannel] = 0;
            state.channelSwitches = Number(state.channelSwitches || 0) + 1;
            clearLockedSixPrediction(userId);
            console.warn(`[CHANNEL SWITCH] ${userId}: ${activeChannel} reached 5 losses; switching to ${state.activeSixChannel}`);
        }
    }
    state.lossStreak = wasWin ? 0 : (Number(state.lossStreak) || 0) + 1;
    console.log(`[RESULT] ${wasWin ? 'WIN' : 'LOSS'} recorded; next mode will be selected from current-period history`);

    // Channel state machine:
    //   Start: COLOR NORMAL
    //   COLOR NORMAL LOSS -> SIZE NORMAL
    //   SIZE NORMAL LOSS -> SIZE RECOVERY
    //   SIZE RECOVERY LOSS -> COLOR RECOVERY
    //   COLOR RECOVERY LOSS -> COLOR NORMAL
    //   Any RECOVERY WIN -> same channel NORMAL
    //   NORMAL WIN -> remain on the same channel/mode.
    const st = autobetState[userId];
    const cfg = autobetCfg[userId] || {};
    if (st && cfg.enabled && cfg.mode === 'SIZE') {
        // Big/Small mode: NORMAL is analysis; a NORMAL loss switches to
        // OPPOSITE. An OPPOSITE win stays OPPOSITE; an OPPOSITE loss returns
        // to the normal two-result analysis mode.
        const modeBefore = state.sizeOppositeActive === true || state.lastPredictionMode === 'OPPOSITE' || state.sizePredictionMode === 'OPPOSITE' ? 'OPPOSITE' : 'ANALYSIS';
        state.activeChannel = 'SIZE';
        st.waitingForWatchWin = false;
        if (modeBefore === 'OPPOSITE') {
            if (wasWin) {
                state.mode = 'NORMAL';
                state.sizePredictionMode = 'OPPOSITE';
                state.sizeOppositeActive = true;
                st.lastOutcome = 'OPPOSITE_WIN_STAY_OPPOSITE';
            } else {
                state.mode = 'NORMAL';
                state.sizePredictionMode = 'ANALYSIS';
                state.sizeOppositeActive = false;
                st.lastOutcome = 'OPPOSITE_LOSS_TO_ANALYSIS';
            }
        } else if (wasWin) {
            state.mode = 'NORMAL';
            state.sizePredictionMode = 'ANALYSIS';
            state.sizeOppositeActive = false;
            st.lastOutcome = 'ANALYSIS_WIN_STAY_ANALYSIS';
        } else {
            state.mode = 'NORMAL';
            state.sizePredictionMode = 'OPPOSITE';
            state.sizeOppositeActive = true;
            st.lastOutcome = 'ANALYSIS_LOSS_TO_OPPOSITE';
        }
        if (wasWin) {
            st.level = 1; st.sizeLevel = 1; st.numberLevel = 1;
            st.inMart = false; st.consecutiveLoss = 0;
        } else {
            const maxLevel = Math.max(1, Number(cfg.maxLvl) || 1);
            const level = Math.min(maxLevel, Math.max(1, Number(st.level) || 1));
            st.level = level >= maxLevel ? 1 : level + 1;
            st.sizeLevel = st.level; st.numberLevel = st.level;
            st.inMart = st.level > 1;
            st.consecutiveLoss = Number(st.consecutiveLoss || 0) + 1;
            recordLossStreakHit(userId);
        }
    } else if (st && cfg.enabled && cfg.mode === 'COLOR') {
        const channelBefore = state.lastPredictionChannel === 'SIZE' ? 'SIZE' : 'COLOR';
        const modeBefore = state.lastPredictionMode === 'RECOVERY' ? 'RECOVERY' : 'NORMAL';
        st.waitingForWatchWin = false;
        if (wasWin) {
            state.mode = 'NORMAL'; state.activeChannel = channelBefore;
            st.lastOutcome = modeBefore === 'RECOVERY' ? 'RECOVERY_WIN' : 'WIN';
            if (modeBefore === 'RECOVERY') { st.level = 1; st.sizeLevel = 1; st.numberLevel = 1; st.inMart = false; st.consecutiveLoss = 0; }
        } else {
            const next = channelBefore === 'COLOR' && modeBefore === 'NORMAL' ? {channel:'SIZE',mode:'NORMAL'} : channelBefore === 'SIZE' && modeBefore === 'NORMAL' ? {channel:'SIZE',mode:'RECOVERY'} : channelBefore === 'SIZE' ? {channel:'COLOR',mode:'RECOVERY'} : {channel:'COLOR',mode:'NORMAL'};
            state.activeChannel = next.channel; state.mode = next.mode;
            st.lastOutcome = `${channelBefore}_${modeBefore}_LOSS_TO_${next.channel}_${next.mode}`;
            const maxLevel = Math.max(1, Number(cfg.maxLvl) || 1);
            const level = Math.min(maxLevel, Math.max(1, Number(st.level) || 1));
            st.level = level >= maxLevel ? 1 : level + 1; st.sizeLevel = st.level; st.numberLevel = st.level; st.inMart = st.level > 1; st.consecutiveLoss = Number(st.consecutiveLoss || 0) + 1; recordLossStreakHit(userId);
        }
    }
}

function getStatus(userId) { initState(userId); return "SITE_ONLY"; }

function levelMapText(map) {
    const entries = Object.entries(map || {}).filter(([,v]) => Number(v) > 0).sort((a,b) => Number(a[0].slice(1)) - Number(b[0].slice(1)));
    return entries.length ? entries.map(([level,count]) => level + ":" + count).join(" | ") : "None";
}

function formatMartingale(cfg) {
    if (cfg.mode === "COMBINED") {
        return "Size: ₹" + cfg.customSizeBets.slice(0, cfg.maxLvl).join(" → ₹") +
            "\nNumber: ₹" + cfg.customNumberBets.slice(0, cfg.maxLvl).join(" → ₹");
    }
    const sequence = cfg.mode === "NUMBER" ? cfg.customNumberBets : cfg.customBets;
    return "Bet: ₹" + sequence.slice(0, cfg.maxLvl).join(" → ₹");
}

function getStatus(userId) {
    initState(userId);
    return userStates[userId].mode === 'RECOVERY' ? 'RECOVERY' : 'NORMAL';
}

async function sendResultAmountLine(chatId, userId, label, amount) {
    const balance = await getLiveBalance(userId);
    const pnl = Number(profitTrack[userId]?.pnl || 0);
    const balanceText = balance.success
        ? "₹" + Math.floor(Number(balance.balance) || 0)
        : "Unavailable";
    const sign = label === "Profit" ? "+" : "-";
    await send(chatId, label + ": " + sign + "₹" + Math.floor(Math.abs(Number(amount) || 0)) + " | P&L: " + (pnl >= 0 ? "+" : "-") + "₹" + Math.floor(Math.abs(pnl)) + " | Balance: " + balanceText);
}

// ============================================================
// 2. handleWin - UI & Stats
// ============================================================
async function handleWin(userId, chatId, actual, num, betLevel, bets = [], settlement = null) {
    const pt = profitTrack[userId];
    const amt = bets.length ? bets.reduce((sum, b) => sum + Number(b.amt || 0), 0) : getSequenceAmount(userId, betLevel);
    let profit;
    profit = settlement ? Number(settlement.pnl) || 0 : amt * (autobetCfg[userId].mode === "NUMBER" ? NUMBER_WIN_MULTIPLIER - 1 : SIZE_WIN_MULTIPLIER - 1);
    
    pt.totalBets++; pt.wins++; pt.pnl += profit; 
    pt.totalBetAmount = (pt.totalBetAmount || 0) + amt;
    pt.winStreak++; pt.lossStreak = 0;
    if(pt.winStreak > pt.maxW) pt.maxW = pt.winStreak;
    const plan = autobetCfg[userId].profitPlan;
    const switchStep = Math.floor(Number(plan?.profitSwitchStep) || 0);
    const shouldSwitchPlan = plan?.enabled && switchStep > 0 && pt.pnl >= Number(plan.nextProfitSwitch || switchStep);
    if (shouldSwitchPlan) {
        const previousLevel = Number(plan?.currentLevel) || 1;
        await refreshWalletPlan(userId, "win");
        if (plan?.enabled && switchStep > 0) {
            plan.nextProfitSwitch = (Math.floor(pt.pnl / switchStep) + 1) * switchStep;
        }
        if (plan?.enabled) {
            const currentLevel = Number(plan.currentLevel) || 1;
            const sizePlan = (autobetCfg[userId].customSizeBets || []).slice(0, autobetCfg[userId].maxLvl).join(" → ₹");
            const numberPlan = (autobetCfg[userId].customNumberBets || []).slice(0, autobetCfg[userId].maxLvl).join(" → ₹");
            await send(chatId,
                "🔄 Plan switched: L" + previousLevel + " → L" + currentLevel +
                "\nSize: ₹" + sizePlan +
                "\nNumber: ₹" + numberPlan
            );
        }
    }

    await sendResultAmountLine(chatId, userId, "Profit", profit);
    await sendSticker(chatId, WIN_STICKER);
}

// ============================================================
// 3. handleLoss - UI & Stats
// ============================================================
async function handleLoss(userId, chatId, actual, num, betLevel, bets = [], settlement = null) {
    const st = autobetState[userId];
    const pt = profitTrack[userId];
    const amt = bets.length ? bets.reduce((sum, b) => sum + Number(b.amt || 0), 0) : getSequenceAmount(userId, betLevel);
    
    pt.totalBets++; pt.losses++; pt.pnl += settlement ? settlement.pnl : -amt; 
    pt.totalBetAmount = (pt.totalBetAmount || 0) + amt;
    pt.lossStreak++; pt.winStreak = 0;
    if(pt.lossStreak > pt.maxL) pt.maxL = pt.lossStreak;

    const plan = autobetCfg[userId].profitPlan;
    if (plan?.enabled && plan?.profitSwitchStep > 0 && pt.pnl <= 0) {
        await refreshWalletPlan(userId, "loss");
    }

    await sendResultAmountLine(chatId, userId, "Loss", amt);
    await sendSticker(chatId, LOSS_STICKER);
}

// ============================================================
// PREDICT LOOP
// ============================================================
function getActualColorBase(number) {
    const n = Number(number);
    if (n === 0) return 'RED';
    if (n === 5) return 'GREEN';
    return n % 2 === 0 ? 'RED' : 'GREEN';
}

function getActualColorLabel(number) {
    const n = Number(number);
    if (n === 0) return 'RED+VIOLET';
    if (n === 5) return 'GREEN+VIOLET';
    return n % 2 === 0 ? 'RED' : 'GREEN';
}

function parseItem(item) {
    const n = +(item.number || item.winNumber || 0);
    return {
        n,
        size: n >= 5 ? "BIG" : "SMALL",
        color: n === 0 ? "RED" : n === 5 ? "GREEN" : n % 2 === 0 ? "RED" : "GREEN"
    };
}

async function runPredict(userId, chatId) {
    const runKey = String(userId);
    if (runInFlight.has(runKey)) return;
    runInFlight.add(runKey);
    if(!running[userId]) { runInFlight.delete(runKey); return; }
    initUser(userId);
    const state = userStates[userId];
    const st = autobetState[userId];
    const cfg = autobetCfg[userId];

    // The result checker owns the current target period. Keep a short
    // heartbeat alive, but never start a second prediction while settlement
    // is still polling. This prevents the one-prediction-then-stop race.
    if (resultCheckInFlight.has(runKey)) {
        scheduleRun(userId, chatId, 5000);
        runInFlight.delete(runKey);
        return;
    }

    if (st.isWaiting) {
        if (Date.now() >= st.nextStartTime) {
            st.isWaiting = false;
            profitTrack[userId].pnl = 0; 
            await send(chatId, "🔄 Timed Restart! Starting new section...");
        } else {
            scheduleRun(userId, chatId, 30000);
            runInFlight.delete(runKey);
            return;
        }
    }

    const list = await fetchListForUser(userId);
    if (!Array.isArray(list) || list.length === 0) {
        console.warn("[PREDICTION] Draw history unavailable; retrying without emitting a false prediction");
        scheduleRun(userId, chatId, 15000);
        runInFlight.delete(runKey);
        return;
    }

    // The uploaded HTML's API is authoritative for both current history and next period.
    const next = getNextIssue(list);
    if (!next) {
        await send(chatId, "SKIP");
        scheduleRun(userId, chatId, 10000);
        runInFlight.delete(runKey);
        return;
    }
    const dispatched = predictionDispatches.get(runKey) || new Set();
    if (sentPeriods[userId].has(next) || dispatched.has(String(next))) {
        scheduleRun(userId, chatId, 10000);
        runInFlight.delete(runKey);
        return;
    }
    sentPeriods[userId].add(next);
    dispatched.add(String(next));
    while (dispatched.size > MAX_SENT_PERIODS) {
        dispatched.delete(dispatched.values().next().value);
    }
    predictionDispatches.set(runKey, dispatched);
    while (sentPeriods[userId].size > MAX_SENT_PERIODS) {
        sentPeriods[userId].delete(sentPeriods[userId].values().next().value);
    }

    initState(userId);
    const signal = cfg.mode === "COMBINED"
        ? await getCombinedSourcePrediction(list, userId)
        : await decidePrediction(list, next, userId);
    if(!signal) {
        await send(chatId,
            "⏭️ SKIP\n" +
            "Period: " + next.slice(-6) + "\n" +
            "Reason: Prediction signal unavailable"
        );
        scheduleRun(userId, chatId, 5000);
        runInFlight.delete(runKey);
        return;
    }
    if (signal.skip === true) {
        const reason = signal.reason || "Signal filter rejected this period";
        console.log(`[PREDICTION] Skipping period ${next}: ${reason}`);
        await send(chatId,
            "⏭️ SKIP\n" +
            "Period: " + next.slice(-6) + "\n" +
            "Reason: " + reason
        );
        scheduleRun(userId, chatId, 8000);
        runInFlight.delete(runKey);
        return;
    }

    // Confidence is a filter, not a win guarantee. Do not force a bet when
    // the predictor does not report a strong enough signal.
    // Existing source-based signals do not expose a confidence field; keep
    // them eligible, while still filtering any explicitly low-confidence signal.
    const signalConfidence = Number(signal.conf ?? 90);
    const minimumConfidence = 90;
    const isSixPatternSignal = signal.historyBased === true;
    if (!signal.externalPatternSignal && !signal.fallback && !isSixPatternSignal && (!Number.isFinite(signalConfidence) || signalConfidence < minimumConfidence)) {
        const reason = `Confidence ${Number.isFinite(signalConfidence) ? signalConfidence : 0}% < required ${minimumConfidence}%`;
        console.log(`[PREDICTION] Skipping period ${next}: ${reason}`);
        await send(chatId,
            "⏭️ SKIP\n" +
            "Period: " + next.slice(-6) + "\n" +
            "Reason: " + reason
        );
        scheduleRun(userId, chatId, 8000);
        runInFlight.delete(runKey);
        return;
    }

    // Preserve the active analysis/opposite state for SIZE and the channel
    // state for COLOR.
    if (cfg.mode === 'SIZE') {
        if (state.sizePredictionMode !== 'OPPOSITE') state.sizePredictionMode = 'ANALYSIS';
        state.mode = 'NORMAL';
        state.nextPredictionMode = state.sizePredictionMode;
    } else {
        if (cfg.mode === 'COLOR' && state.mode !== 'RECOVERY') state.mode = 'NORMAL';
        state.nextPredictionMode = state.activeChannel || 'COLOR';
    }

    let abLine = signal.fallback
        ? "🤖 AutoBet: OFF (RANDOM FALLBACK)"
        : "🤖 AutoBet: OFF";
    let canBet = false;

    if (!cfg || !cfg.enabled) {
        abLine = signal.fallback
            ? "🤖 AutoBet: OFF (RANDOM FALLBACK)"
            : "🤖 AutoBet: OFF";
        canBet = false;
    } else if (!signal.fallback) {
        // After every live-bet loss, prediction continues but staking pauses.
        // A watch WIN unlocks the next period; watch losses keep the pause.
        if (!['COLOR', 'SIZE'].includes(cfg.mode) && st.waitingForWatchWin) {
            canBet = false;
            abLine = "👀 WATCH MODE: waiting for WIN → next bet L" + st.level;
        } else {
            canBet = true;
            const sequence = cfg.mode === "NUMBER" ? cfg.customNumberBets : cfg.customBets;
            const curBet = sequence[st.level - 1] ?? (cfg.baseBet * (MULT[st.level - 1] || 1));
            abLine = (st.level > 1 ? "📈 MART " : "💰 BET ") + "L" + st.level + ": ₹" + curBet;
        }
    } else {
        canBet = false;
    }

    const patternName = signal && signal.pat ? signal.pat : (state && state.mode ? state.mode : "NORMAL");
    const waitLine = "";

    await send(chatId,
"╔══════════════════════════╗\n"+
"║    👑 EARN WITH ME AI    ║\n"+
"╠══════════════════════════╣\n"+
"║ Period  : "+next.slice(-6)+"\n"+
"║ Game    : SIZE/COLOR\n"+
"║ 🎮 Mode  : "+String(signal.mode || (signal.type === "SIZE" ? state.sizePredictionMode : state.mode) || "NORMAL")+" "+String(signal.type === "SIZE" ? "BIG/SMALL" : (signal.channel || state.activeChannel || "COLOR"))+"\n"+
"║ Mode    : "+String(signal.mode || signal.pat || "PATTERN-5/4")+"\n"+
"║ Pattern : "+String(signal.pattern || "LAST-5/LAST-4")+"\n"+
"║ Number  : "+String(signal.number ?? "-")+"\n"+
"║ Conf.   : "+String(signal.conf ?? signal.numberConfidence ?? "-")+"% | Hist "+String(signal.historicalWinRate ?? "-")+"%\n"+
"║ "+(signal.type === "COLOR" ? "Color   : " : "Size    : ")+signal.val+"\n"+
"║ "+(signal.type === "SIZE" ? "Analysis: "+String(signal.analysis || signal.val)+"\n" : "")+
"║ Result  : "+formatPrediction(signal)+"\n"+
"║ Source  : LAST 2 RESULTS COMPARISON\n"+
"╠══════════════════════════╣\n"+
"║ "+abLine+"\n"+
waitLine+"\n"+
"╚══════════════════════════╝",
        {reply_markup:{inline_keyboard:[[{text:"💰 CHECK NOW",url:REG_LINK}]]}}
    );

    let placedBets = [];
    if (canBet) {
        const rawSpecs = signal.bets || [{ type: signal.type, val: signal.val, kind: signal.type === "NUMBER" ? "number" : "size" }];
        // Enforce exactly one SIZE and one NUMBER for each period in COMBINED mode.
        const sizeSpec = rawSpecs.find(spec => spec.type === "SIZE");
        const colorSpec = rawSpecs.find(spec => spec.type === "COLOR");
        const numberSpec = rawSpecs.find(spec => spec.type === "NUMBER");
        const specs = cfg.mode === "COMBINED"
            ? [sizeSpec, numberSpec].filter(Boolean)
            : [colorSpec || sizeSpec || numberSpec].filter(Boolean);
        const combinedAmounts = getCombinedBetAmounts(userId, st.sizeLevel, st.numberLevel);
        for (const spec of specs) {
            const isNumber = spec.type === "NUMBER";
            const levelForBet = cfg.mode === "COMBINED"
                ? (isNumber ? combinedAmounts.numberLevel : combinedAmounts.sizeLevel)
                : st.level;
            const sequence = isNumber ? cfg.customNumberBets : cfg.customBets;
            const amount = cfg.mode === "COMBINED"
                ? (isNumber ? combinedAmounts.number : combinedAmounts.size)
                : (sequence[levelForBet - 1] ?? (cfg.baseBet * (MULT[levelForBet - 1] || 1)));
            const result = await placeBet(userId, chatId, next, spec.val, spec.type, levelForBet, amount);
            if (result && result.ok) placedBets.push({ ...spec, amt: result.amt, level: levelForBet });
            else await send(chatId, "❌ Bet Failed (" + spec.type + "): " + (result?.msg || "Unknown error"));
        }
        if (cfg.mode === "COMBINED" && placedBets.length !== 2) {
            // Never treat a partial combined pair as a valid combined settlement.
            await send(chatId, "⚠️ Combined bet incomplete for period " + next + ". Expected exactly 1 size + 1 number; settlement will use only the confirmed stake.");
        }
        if (placedBets.length) {
            const levelText = cfg.mode === "COMBINED"
                ? "Size L" + combinedAmounts.sizeLevel + " / Number L" + combinedAmounts.numberLevel
                : "L" + st.level;
            await send(chatId, "✅ Bets Success: " + placedBets.length + " | " + levelText + "\n" + placedBets.map(b => b.type + "=" + b.val + " ₹" + b.amt).join("\n") + "\n⏳ Checking result...");
        }
    }

    // Pass the signal bets separately so WATCH mode can evaluate predictions even when AutoBet is OFF.
    const rawPredictedBets = signal.bets || [{ type: signal.type, val: signal.val, kind: signal.type === "NUMBER" ? "number" : "size" }];
    const predictedBets = cfg.mode === "COMBINED"
        ? rawPredictedBets.filter(spec => spec.type === "SIZE" || spec.type === "NUMBER")
        : cfg.mode === "NUMBER"
            ? rawPredictedBets.filter(spec => spec.type === "NUMBER")
            : rawPredictedBets.filter(spec => spec.type === "SIZE" || spec.type === "COLOR");
    checkResult(userId, chatId, next, signal.val, signal.type, placedBets, predictedBets);
    // Heartbeat fallback: checkResult normally schedules after settlement;
    // this timer guarantees recovery if a network/API edge case leaves it
    // waiting. The guard above prevents overlapping bets.
    scheduleRun(userId, chatId, 7000);
    runInFlight.delete(runKey);
}

// ============================================================
// RESULT CHECKER
// ============================================================
async function checkResult(userId, chatId, target, predicted, predType, placedBets, predictedBets = []) {
    const timerKey = String(userId);
    if (resultCheckInFlight.has(timerKey)) return;
    resultCheckInFlight.add(timerKey);
    const previousTimer = resultCheckTimers.get(timerKey);
    if (previousTimer) clearTimeout(previousTimer);
    let tries = 0;
    let callbackBusy = false;
    const cfg = autobetCfg[userId];
    const st = autobetState[userId];
    const pt = profitTrack[userId];
    
    const releaseResultCheck = () => {
        if (iv) clearTimeout(iv);
        if (resultCheckTimers.get(timerKey) === iv) resultCheckTimers.delete(timerKey);
        resultCheckInFlight.delete(timerKey);
        callbackBusy = false;
    };
    let iv;
    const tick = async () => {
        if (callbackBusy) return;
        callbackBusy = true;
        try {
        if (!running[userId]) {
            releaseResultCheck();
            return;
        }
        if (++tries > 25) {
            releaseResultCheck();
            await logBoth(chatId, "⏱ Timeout — checking next period...");
            scheduleRun(userId, chatId, 15000);
            return;
        }
        const list = await fetchListForUser(userId);
        if (!list) {
            releaseResultCheck();
            scheduleRun(userId, chatId, 10000);
            return;
        }
        if (!/^\d+$/.test(String(list[0]?.issueNumber || ""))) {
            releaseResultCheck();
            scheduleRun(userId, chatId, 5000);
            return;
        }
        if (BigInt(list[0].issueNumber) < BigInt(target)) {
            callbackBusy = false;
            iv = setTimeout(tick, 10000);
            resultCheckTimers.set(timerKey, iv);
            return;
        }
        releaseResultCheck();

        const res = list.find(i => String(i.issueNumber) === String(target));
        if (!res) {
            scheduleRun(userId, chatId, 5000);
            return;
        }
        const num = parseInt(res.number || res.winNumber, 10);
        if (!Number.isFinite(num) || num < 0 || num > 9) {
            scheduleRun(userId, chatId, 5000);
            return;
        }

        // The result endpoint can be read more than once while timers overlap.
        // Mark this period before sending any notification.
        const settled = settledPeriods.get(timerKey) || new Set();
        if (settled.has(String(target))) {
            scheduleRun(userId, chatId, 5000);
            return;
        }
        settled.add(String(target));
        while (settled.size > MAX_SENT_PERIODS) settled.delete(settled.values().next().value);
        settledPeriods.set(timerKey, settled);

        const actualSize = num >= 5 ? "BIG" : "SMALL";
        const actualColor = getActualColorBase(num);
        const actualColorLabel = getActualColorLabel(num);

        const bets = Array.isArray(placedBets) ? placedBets : [];
        const betPlaced = bets.length > 0;
        // In WATCH mode, evaluate the original signal because no placed-bets array exists.
        // Colors are ignored; a category OR exact-number match is a WIN.
        const evaluationBets = betPlaced ? bets : (Array.isArray(predictedBets) ? predictedBets : []);
        const sizeMatched = evaluationBets.some(b => b.type === "SIZE" && b.val === actualSize);
        const numberMatched = evaluationBets.some(b => b.type === "NUMBER" && Number(b.val) === num);
        const colorMatched = evaluationBets.some(b => b.type === "COLOR" && String(b.val).toUpperCase() === actualColor);
        const isCombinedBet = evaluationBets.some(b => b.type === "SIZE") && evaluationBets.some(b => b.type === "NUMBER");
        // In COMBINED mode, a NUMBER win resets both size and number levels,
        // even if the size leg was not placed or did not match.
        const combinedResult = cfg.mode === "COMBINED" && (isCombinedBet || numberMatched);
        const settlement = betPlaced ? calculateSettlement(bets, actualSize, num) : null;
        const win = settlement ? settlement.won : evaluationBets.some(b => b.type === "NUMBER"
            ? Number(b.val) === num
            : b.type === "COLOR" ? String(b.val).toUpperCase() === actualColor
            : b.type === "SIZE" && b.val === actualSize);
        if (cfg.mode === "COMBINED") {
            const predictedSize = evaluationBets.find(b => b.type === "SIZE")?.val || "-";
            const predictedNumber = evaluationBets.find(b => b.type === "NUMBER")?.val;
            const sizeStatus = sizeMatched ? "WIN ✅" : "LOSS ❌";
            const numberStatus = numberMatched ? "WIN ✅" : "LOSS ❌";
            await send(chatId,
                "🎮 COMBINED RESULT\n" +
                `Period: ${target}\n` +
                `Size: ${predictedSize} → ${actualSize} (${sizeStatus})\n` +
                `Number: ${predictedNumber ?? "-"} → ${num} (${numberStatus})\n` +
                `Overall: ${win ? "WIN ✅" : "LOSS ❌"}`
            );
        }
        // Exact flip rules from the new Netlify page. Apply only after LOSS.
        if (cfg.mode === "COMBINED") {
            const sourceState = userStates[String(userId)] || (userStates[String(userId)] = {});
            sourceState.combinedFlipNext = false;
            if (!win && Array.isArray(list)) {
                const currentIndex = list.findIndex(item => String(item?.issueNumber) === String(target));
                const current = list[currentIndex >= 0 ? currentIndex : 0];
                const previous = list[currentIndex >= 0 ? currentIndex + 1 : 1];
                const beforePrevious = list[currentIndex >= 0 ? currentIndex + 2 : 2];
                const currentNumber = getResultNumber(current);
                const previousNumber = getResultNumber(previous);
                const beforePreviousNumber = getResultNumber(beforePrevious);

                const color = n => Number(n) % 2 === 0 ? 'RED' : 'GREEN';
                const samePair = (a, b) => a !== null && b !== null &&
                    color(a) === color(b) && getCombinedStrategySize(a) === getCombinedStrategySize(b);

                if (currentNumber !== null && previousNumber !== null && beforePreviousNumber !== null) {
                    const sameColor3 = color(currentNumber) === color(previousNumber) &&
                        color(previousNumber) === color(beforePreviousNumber);
                    const sameStrategySize3 = getCombinedStrategySize(currentNumber) ===
                        getCombinedStrategySize(previousNumber) &&
                        getCombinedStrategySize(previousNumber) === getCombinedStrategySize(beforePreviousNumber);
                    const mixedSize3 = !sameStrategySize3;

                    if (sameColor3 && sameStrategySize3) {
                        sourceState.combinedFlipNext = true;
                    } else if (sameColor3 && mixedSize3) {
                        sourceState.combinedFlipNext = false;
                    } else {
                        sourceState.combinedFlipNext = samePair(currentNumber, previousNumber);
                    }
                } else if (currentNumber !== null && previousNumber !== null) {
                    sourceState.combinedFlipNext = samePair(currentNumber, previousNumber);
                }
            }
        }

        if (!betPlaced) {
            await send(chatId,
                "╔══════════════════════════╗\n" +
                `║  👀 WATCH RESULT: ${win ? 'WIN ✅' : 'LOSS ❌'}  ║\n` +
                "╠══════════════════════════╣\n" +
                `║ Number : ${num}\n` +
                `║ Result : ${actualSize}\n` +
                `║ Colour : ${actualColorLabel}\n` +
                `║ Status : ${win ? 'Correct Prediction' : 'Incorrect Prediction'}\n` +
                `║ Next   : ${userStates[userId]?.nextPredictionMode || 'NORMAL'}\n` +
                "╚══════════════════════════╝"
            );
        }

        const betLevel = st.level;
        const sizeBetLevel = st.sizeLevel;
        const numberBetLevel = st.numberLevel;
        if (betPlaced) {
            const key = "L" + betLevel;
            st.levelHistory[key] = (st.levelHistory[key] || 0) + 1;
            const keys = Object.keys(st.levelHistory).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
            while (keys.length > MAX_LEVEL_HISTORY) delete st.levelHistory[keys.shift()];
        }

        // Combined settlement updates its two live legs only when a real pair
        // was placed. A watch result must go through the common watch state
        // machine so a watch WIN unlocks the next period.
        if (combinedResult && betPlaced) updateCombinedAfterResult(userId, sizeMatched, numberMatched, betPlaced);
        else updateAfterResult(userId, win, actualSize, betPlaced);

        const s = stats[userId];
        if (betPlaced) {
            if (combinedResult) {
                if (sizeMatched) s.sizeLevelWins["L" + sizeBetLevel] = (s.sizeLevelWins["L" + sizeBetLevel] || 0) + 1;
                if (numberMatched) s.numberLevelWins["L" + numberBetLevel] = (s.numberLevelWins["L" + numberBetLevel] || 0) + 1;
            } else if (win) {
                s.levelWins["L" + betLevel] = (s.levelWins["L" + betLevel] || 0) + 1;
            }
        }
        s.total++;
        if (win) {
            s.win++; s.winStreak++; s.lossStreak = 0;
            if (s.winStreak > s.maxWinStreak) s.maxWinStreak = s.winStreak;
        } else {
            s.loss++; s.lossStreak++; s.winStreak = 0;
            if (s.lossStreak > s.maxLossStreak) s.maxLossStreak = s.lossStreak;
        }

        if (betPlaced) {
            if (win && settlement) {
                await handleWin(userId, chatId, actualSize, num, betLevel, bets, settlement);
            } else if (win) {
                await handleWin(userId, chatId, actualSize, num, betLevel, bets);
            } else if (settlement) {
                await handleLoss(userId, chatId, actualSize, num, betLevel, bets, settlement);
            } else {
                await handleLoss(userId, chatId, actualSize, num, betLevel, bets);
            }

            const targetProfit = Number(cfg.targetProfit) || 1000;
            if (pt.pnl >= targetProfit) {
                st.isWaiting = true;
                st.nextStartTime = Date.now() + (Number(cfg.restartDelay) || 1) * 60 * 1000;
                await send(chatId, "🎯 TARGET REACHED! Bot Paused.");
            }
        } else {
            if (win) {
                await sendSticker(chatId, WIN_STICKER);
            } else {
                await sendSticker(chatId, LOSS_STICKER);
            }
        }

        const predictionHistory = userStates[userId].resultHistory || [];
        predictionHistory.unshift({
            latestResultNumber: userStates[userId].lastPredictionNumber,
            status: win ? "WIN" : "LOSE",
            mappingMode: userStates[userId].lastSelectionMode
        });
        userStates[userId].resultHistory = predictionHistory.slice(0, 100);

        scheduleRun(userId, chatId, 8000);
        } catch (error) {
            const settled = settledPeriods.get(timerKey);
            settled?.delete(String(target));
            releaseResultCheck();
            console.error("[RESULT CHECK ERROR]", error?.message || error);
            if (running[userId]) scheduleRun(userId, chatId, 10000);
        } finally {
            callbackBusy = false;
        }
    };
    iv = setTimeout(tick, 7000);
    resultCheckTimers.set(timerKey, iv);
}

module.exports = { decidePrediction, updateAfterResult, getStatus, initState, buildBSFromList, runPredict, checkResult };

function showStats(chatId,userId){
    initUser(userId);
    const d = stats[userId];
    const st = autobetState[userId];
    const pt = profitTrack[userId];
    const total = Number(d.total) || 0;
    const rate = total ? ((d.win / total) * 100).toFixed(1) : "0.0";
    const bar = "🟦".repeat(total ? Math.round(d.win / total * 10) : 0) + "⬜".repeat(total ? 10 - Math.round(d.win / total * 10) : 10);
    const history = userStates[userId]?.resultHistory || [];
    const primary = history.filter(item => item.mappingMode === "PRIMARY");
    const alternative = history.filter(item => item.mappingMode === "ALTERNATIVE");
    const mappingLine = modeItems => {
        const wins = modeItems.filter(item => item.status === "WIN").length;
        return modeItems.length ? `${wins}W/${modeItems.length - wins}L (${((wins / modeItems.length) * 100).toFixed(1)}%)` : "None";
    };
    send(chatId,
"📊 DETAILED STATS\n\n"+
"Results     : "+total+"\n"+
"Wins/Losses : "+(d.win||0)+" / "+(d.loss||0)+"\n"+
"Accuracy    : "+rate+"%\n"+bar+"\n\n"+
"Current     : L"+st.level+(autobetCfg[userId].mode === "COMBINED" ? " (S"+st.sizeLevel+"/N"+st.numberLevel+")" : "")+"\n"+
"Win streak  : "+(d.winStreak||0)+" | Best: "+(d.maxWinStreak||0)+"\n"+
"Loss streak : "+(d.lossStreak||0)+" | Worst: "+(d.maxLossStreak||0)+"\n"+
"Streak hits : "+(pt.lossStreakHits||0)+" (threshold L"+(autobetCfg[userId].watchLoss||1)+")\n"+
"P&L         : "+(pt.pnl>=0?"+":"")+Number(pt.pnl||0).toFixed(2)+"\n"+
"Staked      : ₹"+Number(pt.totalBetAmount||0).toFixed(2)+"\n\n"+
"Level wins  : "+levelMapText(d.levelWins)+"\n"+
"Level usage : "+levelMapText(st.levelHistory)+"\n"+
"PRIMARY     : "+mappingLine(primary)+"\n"+
"ALTERNATIVE : "+mappingLine(alternative)
    );
}
async function profitReport(chatId,userId){
    initUser(userId);
    const pt=profitTrack[userId],cfg=autobetCfg[userId];
    const rate=pt.totalBets?((pt.wins/pt.totalBets)*100).toFixed(1):"0.0";
    let balance = "❌ No token";
    const balResult = await getLiveBalance(userId);
    if(balResult.success){
        balance = "₹"+balResult.balance;
    } else if (balResult.message){
        balance = "⚠️ "+balResult.message;
    }
    send(chatId,
"💰 PROFIT REPORT\n\n"+
"Balance: "+balance+"\n"+
"Bets   : "+pt.totalBets+"\nWins   : "+pt.wins+"\nLoss   : "+pt.losses+"\nRate   : "+rate+"%\n"+
"P&L    : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(2)+"\n"+
"Streak : "+pt.winStreak+"W / "+pt.lossStreak+"L\n"+
"Streak hits: "+(pt.lossStreakHits||0)+" (threshold L"+(cfg.watchLoss||1)+")\n"+
"Best W : "+Number(pt.maxW||0)+" | Max loss streak: "+Number(pt.maxL||0)+"\n"+
"Staked : ₹"+Number(pt.totalBetAmount||0).toFixed(2)+"\n"+
"Level  : L"+autobetState[userId].level+" / "+cfg.maxLvl+"\n"+
(cfg.profitPlan?.enabled ? "Plan   : ON | Balance ₹"+Number(cfg.profitPlan.planBalance||0).toFixed(0)+" | Max L"+cfg.profitPlan.maxLevel+"\n" : "Plan   : OFF\n")+
"Profit switch: "+(cfg.profitPlan?.profitSwitchStep ? "Every ₹"+cfg.profitPlan.profitSwitchStep+" (next ₹"+cfg.profitPlan.nextProfitSwitch+")" : "OFF")+"\n"+
"\n"+
formatMartingale(cfg)
    );
}
async function autobetStatus(chatId, userId) {
    initUser(userId);
    const cfg = autobetCfg[userId], st = autobetState[userId], pt = profitTrack[userId];
    const creds = userCreds[userId] || {};

    let liveBal = "❌ No token";
    let token = getToken(userId);
    const hasToken = token && token.length > 20;
    if (hasToken) {
        const result = await getLiveBalance(userId);
        if (result.success) {
            liveBal = "₹" + result.balance;
        } else {
            liveBal = "⚠️ " + result.message;
        }
    } else if (creds.phone) {
        liveBal = "❌ Login Required";
    }

    let waitLine = "";
    if (st.isWaiting) {
        const diff = Math.round((st.nextStartTime - Date.now()) / 60000);
        waitLine = "\n⏳ Waiting: " + diff + " mins to restart";
    }

    send(chatId,
"🤖 AUTOBET STATUS\n\n"+
"💰 Live Balance: "+liveBal+"\n"+
"Enabled  : "+(cfg.enabled?"✅ ON":"❌ OFF")+"\n"+
"Token    : "+(token.length>20?"✅":"❌")+"\n"+
"AutoLogin: "+(creds.phone?"✅ "+creds.phone.slice(0,6)+"***":"❌")+"\n"+
"Mode     : "+modeLabel(cfg.mode)+"\n"+
    (cfg.mode === "COMBINED" ? "Size Bets: ₹"+cfg.customSizeBets.join(" → ₹")+"\nNum Bets : ₹"+cfg.customNumberBets.join(" → ₹")+"\nRule     : 1 site size + 1 site number\n" : "Bet Seq  : ₹"+cfg.customBets.join(" → ₹")+"\n")+
"Watch    : "+(cfg.watch?"ON":"OFF")+"\n"+
"WatchLoss: "+st.consecutiveLoss+"/"+cfg.watchLoss+"\n"+
"Bet Flow : "+(st.waitingForWatchWin ? "WATCH — next WIN unlocks L"+st.level : "BET NEXT PERIOD")+"\n"+
"Base Bet : ₹"+cfg.baseBet+"\n"+
"Max Level: "+cfg.maxLvl+"\n"+
"Target Profit: ₹"+cfg.targetProfit+"\n"+
"Profit switch: "+(cfg.profitPlan?.profitSwitchStep ? "Every ₹"+cfg.profitPlan.profitSwitchStep+" (next ₹"+cfg.profitPlan.nextProfitSwitch+")" : "OFF")+"\n"+
"Section Delay: "+cfg.restartDelay+" mins"+ // Hours-la irunthu Minutes-ku mathi irukken
waitLine+"\n"+
"In Mart  : "+(st.inMart?"YES":"NO")+"\n"+
(cfg.mode === "COMBINED" ? "Size L"+st.sizeLevel+" | Number L"+st.numberLevel+"\n" : "Current  : L"+st.level+"\n")+
"Last Win : "+(st.lastWinLevel?"L"+st.lastWinLevel+" ("+(st.lastWinMode||cfg.mode)+")":"None")+"\n"+
(cfg.mode === "COMBINED" ? "Size Hist: "+(Object.entries(st.sizeLevelHistory||{}).map(([level,count]) => level+":"+count).join(" | ") || "None")+"\nNumber Hist: "+(Object.entries(st.numberLevelHistory||{}).map(([level,count]) => level+":"+count).join(" | ") || "None")+"\n" : "History  : "+(Object.entries(st.levelHistory||{}).map(([level,count]) => level+":"+count).join(" | ") || "None")+"\n")+
"Wins Lvl : "+(cfg.mode === "COMBINED" ? "Size "+levelMapText(stats[userId].sizeLevelWins)+" | Number "+levelMapText(stats[userId].numberLevelWins) : levelMapText(stats[userId].levelWins))+"\n"+
"P&L      : "+(pt.pnl>=0?"+":"")+pt.pnl.toFixed(2)+"\n\n"+
formatMartingale(cfg)
    );
}



// ============================================================
//  KEYBOARDS
// ============================================================
function userMenu(id){
    const rows=[["▶️ Start Prediction"],["⏹ Stop Prediction"],["📊 Stats","💰 Profit","📩 Contact"],["🤖 AutoBet Setup","🔐 Login"]];
    if(isAdmin(id))rows.push(["👑 Admin Panel"]);
    return{keyboard:rows,resize_keyboard:true};
}
const ownerMenu={keyboard:[["👥 All Users","👮 All Admins"],["👤 Add Admin","🗑 Remove Admin"],["🔑 Generate Key","📋 All Keys"],["🟢 Add User","🔴 Remove User"],["🔐 Set Token","📊 All Status"],["🚪 Owner Logout"]],resize_keyboard:true};
const adminMenu={keyboard:[["👥 Active Users","🔑 Generate Key"],["🟢 Add User","🔴 Remove User"],["📋 All Keys","🚪 Admin Logout"]],resize_keyboard:true};
const autobetMenu={keyboard:[
    ["✅ Enable AutoBet","❌ Disable AutoBet"],
    ["👀 Watch Mode ON","👀 Watch Mode OFF"],
    ["📈 Profit Plan ON","📉 Profit Plan OFF"],
    ["💰 Set Base Bet","📈 Set Max Level"],
    ["🧠 Set Plan Level","🎯 Set Profit Target"],
    ["💹 Set Profit Switch"],
    ["⏳ Set Section Delay","🔢 Set Watch Losses"],
    ["📊 AutoBet Status","🔀 Customize Bet"],
    ["🎮 Mode: Big/Small","🎨 Mode: Color"],
    ["🔢 Mode: Number"],
    ["🔀 Mode: BigSmall+Number","🔙 Back"]
],resize_keyboard:true};

// ============================================================
//  BOT INIT
// ============================================================
let bot;
let handlersAttachedTo = null;
let pollingRecovery = false;
function recoverPolling(err) {
    if (pollingRecovery || !bot) return;
    pollingRecovery = true;
    console.warn("[POLL] Recovering from polling error:", err?.message || err);
    bot.stopPolling().catch(() => {});
    setTimeout(() => {
        try {
            bot.startPolling();
            console.log("[POLL] Polling restarted successfully.");
        } catch (e) {
            console.error("[POLL] Polling restart failed:", e?.message || e);
        } finally {
            pollingRecovery = false;
        }
    }, 5000);
}
function startBot(){
    if (bot) {
        console.warn("[BOT] startBot() ignored because polling is already active.");
        return;
    }
    if (!BOT_TOKEN) throw new Error("BOT_TOKEN environment variable is required");
    if(bot){try{bot.stopPolling();}catch(e){}}
    bot=new TelegramBot(BOT_TOKEN,{polling:{interval:1000,autoStart:true,params:{timeout:30}}});
    bot.on("polling_error",err=>{
        const msg = err?.message || String(err);
        if (msg.includes("409") || msg.toLowerCase().includes("terminated by other getupdates request")) {
            console.error("[POLL] 409 Conflict: another bot instance is using this token. Polling stopped; keep only one deployed instance running.");
            pollingRecovery = true;
            bot.stopPolling().catch(() => {});
            return;
        }
        if (msg.includes("ECONNRESET") || msg.includes("EFATAL") || msg.includes("socket hang up")) {
            recoverPolling(err);
            return;
        }
        console.error("Poll:", msg);
    });
    bot.on("error",err=>{
        const msg = err?.message || String(err);
        if (msg.includes("409") || msg.toLowerCase().includes("terminated by other getupdates request")) {
            console.error("[POLL] 409 Conflict: stop the duplicate bot instance, then redeploy this one.");
            bot.stopPolling().catch(() => {});
            return;
        }
        if (msg.includes("ECONNRESET") || msg.includes("EFATAL") || msg.includes("socket hang up")) {
            console.warn("Bot error recovered:", msg);
            return;
        }
        console.error("Bot:", msg);
    });
    addHandlers();
    console.log("✅ SIVA BOT running...");

}

async function send(chatId,text,opts={}){
    try{return await bot.sendMessage(chatId,text,opts);}
    catch(e){if(e.message&&e.message.includes("parse entities")){try{const o={...opts};delete o.parse_mode;return await bot.sendMessage(chatId,text,o);}catch(e2){}}console.error("send:",e.message?.substr(0,60));}
}

// Telegram messages have a size limit; preserve every member's details by
// sending a long owner report in readable chunks.
async function sendLongText(chatId, text, opts = {}) {
    const limit = 3900;
    const value = String(text || "");
    if (value.length <= limit) return send(chatId, value, opts);
    let rest = value;
    while (rest.length > limit) {
        let cut = rest.lastIndexOf("\n------------------------\n", limit);
        if (cut < 500) cut = rest.lastIndexOf("\n", limit);
        if (cut < 1) cut = limit;
        await send(chatId, rest.slice(0, cut), opts);
        rest = rest.slice(cut).trimStart();
    }
    if (rest) await send(chatId, rest, opts);
}

// Shared logger used by autoLogin() and captcha-solver-free.js.
// Signature: logBoth(chatId, message, isError)
async function logBoth(chatId, message, isError = false) {
    const text = String(message || "");
    if (isError) console.error(text);
    else console.log(text);
    if (chatId !== undefined && chatId !== null) {
        await send(chatId, text);
    }
}

async function sendSticker(chatId,sid){try{await bot.sendSticker(chatId,sid);}catch(e){}}

// ============================================================
//  AUTO LOGIN TASK
// ============================================================


// ============================================================
//  HANDLERS
// ============================================================
function addHandlers(){
    if (handlersAttachedTo === bot) return;
    handlersAttachedTo = bot;
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

     bot.onText(/\/(?:setcreds|setcredts) ?(.*)/,(msg,match)=>{
        const id=String(msg.from.id);
        if(!hasAccess(id))return send(id,"❌ No access.");
        const rest = (match[1] || "").trim();
        if (rest && rest.includes(" ")) {
            const parts = rest.split(/\s+/);
            const phone = parts[0].trim();
            const pass = parts.slice(1).join(" ");
            if (!/^\d{10,15}$/.test(phone)) {
                return send(id, "❌ Invalid mobile number. Use 10-15 digits, for example: 916381605525");
            }
            if (!pass.trim()) {
                return send(id, "❌ Password cannot be empty. Use: /setcreds MOBILE PASSWORD  (or /setcredts)");
            }
            credsSetupState[id] = { step: 3, phone, pass };
            const summary =
                "📋 Confirm your credentials:\n\n" +
                "📱 Mobile: " + phone + "\n" +
                "🔑 Password: " + "*".repeat(Math.min(pass.length, 8)) + "\n\n" +
                "Is this correct?";
            return send(id, summary, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "✅ Yes", callback_data: "creds_confirm_yes" }, { text: "❌ No", callback_data: "creds_confirm_no" }]
                    ]
                }
            });
        }
        credsSetupState[id] = { step: 1 };
        send(id, "📱 Please enter your Mobile Number (e.g. 916381605525):");
    });


    bot.onText(/^\/setmytoken(?:\s+)(.+)$/i, async (msg, match) => {
        const id = String(msg.from.id);
        if (!hasAccess(id)) return send(id, "❌ No access.");

        const applied = applyMyToken(id, match[1]);
        if (!applied.ok) return send(id, "❌ " + applied.reason + "!");

        const balResult = await getLiveBalance(id, msg.chat.id);
        let balanceLine = "";
        if (balResult.success) {
            balanceLine = "\n💰 Live Balance: ₹" + balResult.balance;
        } else if (balResult.message) {
            balanceLine = "\n⚠️ Balance: " + balResult.message;
        }

        return send(
            id,
            "✅ Token loaded in bot memory!\n..." + applied.token.slice(-12) + balanceLine +
                "\n🤖 Now press 🔐 Login or ✅ Enable AutoBet"
        );
    });

    async function beginUserLogin(id, chatId) {
        id = String(id);
        initUser(id);
        if (!hasAccess(id)) return send(chatId, "❌ No access.");

        const creds = userCreds[id] || {};
        if (!creds.phone || !creds.pass) {
            credsSetupState[id] = { step: 1 };
            return send(chatId, "📱 First-time login setup. Enter your mobile number (e.g. 916381605525):");
        }

        await send(chatId, "🔄 Starting website login...");
        const loginResult = await autoLogin(id, chatId, false);
        // autoLogin() already applied the token through applyMyToken().
        const cachedToken = getToken(String(id));
        if (cachedToken) {
            console.log(`[TOKEN CACHE VERIFIED] user=${String(id)}; length=${cachedToken.length}`);
            const balResult = await getLiveBalance(id, chatId);
            let balanceLine = "";
            if (balResult.success) {
                balanceLine = "\n💰 Live Balance: ₹" + balResult.balance;
            } else if (balResult.message) {
                balanceLine = "\n⚠️ Balance: " + balResult.message;
            }
            await send(chatId, "✅ Login Success!\n🔑 GetBalance token saved in bot memory: ..." + cachedToken.slice(-12) + balanceLine + "\n🤖 Now press ✅ Enable AutoBet");
        } else if (loginResult) {
            await send(chatId, "❌ Login completed, but no verified GetBalance token was saved. Please try Login again.");
        } else {
            await send(chatId, "❌ Login failed. Check the credentials, website response, or CAPTCHA result and try again.");
        }
    }

    bot.onText(/^\/login(?:@\w+)?$/, async (msg) => {
        await beginUserLogin(String(msg.from.id), msg.chat.id);
    });

    bot.onText(/\/owner/,(msg)=>{
        if(msg.from.id!==OWNER_ID)return;
        if(ownerLoggedIn)return send(OWNER_ID,"Already in!",{reply_markup:ownerMenu});
        ownerState={action:"login"};send(OWNER_ID,"� Owner password:");
    });

    bot.onText(/\/adminlogin (.+)/,(msg,match)=>{
        const id=msg.from.id,pass=match[1].trim();
        if(!isAdmin(id))return send(id,"Not admin.");
        if(pass===adminPasswords[id]){adminLoggedIn[id]=true;send(id,"✅ Admin Login!",{reply_markup:adminMenu});}
        else send(id,"❌ Wrong!");
    });

    bot.on("callback_query", async (cb) => {
        const id = cb.from.id;
        const data = cb.data || "";
        const chatId = cb.message && cb.message.chat ? cb.message.chat.id : id;
        try { await bot.answerCallbackQuery(cb.id); } catch (e) {}

        if (data === "login_menu_login") {
            return beginUserLogin(String(id), chatId);
        }

        if (data === "login_menu_settoken") {
            return send(chatId,
                "🔑 To save or replace your token, send this command:\n\n" +
                "/setmytoken YOUR_TOKEN\n\n" +
                "After saving, press 🔐 Login again.");
        }

        if (data === "creds_confirm_yes") {
            const s = credsSetupState[id];
            if (!s || !s.phone || !s.pass) {
                credsSetupState[id] = { step: 1 };
                return send(chatId, "⚠️ Session expired. Let's start over.\n\n📱 Please enter your Mobile Number (e.g. 916381605525):");
            }
            if (!userCreds[id]) userCreds[id] = {};
            userCreds[id].phone = s.phone;
            userCreds[id].pass = s.pass;
            delete credsSetupState[id];
            // Run one explicit login attempt only. Automatic relogin is reserved for token expiry/401.
            await beginUserLogin(id, chatId);
        } else if (data === "creds_confirm_no") {
            credsSetupState[id] = { step: 1 };
            send(chatId, "🔁 Let's try again.\n\n📱 Please enter your Mobile Number (e.g. 916381605525):");
        }
    });
    bot.on("message",async msg=>{
        const id=msg.from.id,text=msg.text;
        if(!text||text.startsWith("/"))return;
                initUser(id);

        // Interactive credential setup started by the My Token button.
        if (hasAccess(id) && credsSetupState[id]) {
            const setup = credsSetupState[id];

            if (setup.step === 1) {
                const phone = text.trim();
                if (!/^\d{10,15}$/.test(phone)) {
                    return send(id, "❌ Invalid mobile number. Example: 916381605525");
                }
                credsSetupState[id] = { step: 2, phone };
                return send(id, "🔑 Please enter your password:");
            }

            if (setup.step === 2) {
                const pass = text.trim();
                if (!pass) return send(id, "❌ Password cannot be empty.");

                credsSetupState[id] = { step: 3, phone: setup.phone, pass };
                return send(id, "📋 Confirm your credentials:\n\n" +
                    "📱 Mobile: " + setup.phone + "\n" +
                    "🔑 Password: " + "*".repeat(Math.min(pass.length, 8)) + "\n\n" +
                    "Is this correct?", {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "✅ Yes", callback_data: "creds_confirm_yes" },
                            { text: "❌ No", callback_data: "creds_confirm_no" }
                        ]]
                    }
                });
            }
        }

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
            else if(s.action==="removeuser"){const t=parseInt(text);if(isNaN(t))return;if(Number(t)===Number(OWNER_ID))return send(OWNER_ID,"❌ Owner access cannot be removed.",{reply_markup:ownerMenu});const was=hasAccess(t);cleanupUserResources(t, true);ownerState=null;send(OWNER_ID,was?"🚫 Removed":"⚠️ Not active",{reply_markup:ownerMenu});if(was)send(t,"🔴 Access removed.");return;}
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
            if(text==="📊 All Status") {
                return sendLongText(OWNER_ID, "📊 TEAM MEMBERS — COMPLETE FUND & LEVEL DETAILS 📊\n\n" + ownerMemberDetails());
            }
            if(text==="🚪 Owner Logout") {ownerLoggedIn=false;return send(OWNER_ID,"🔒 Out.",{reply_markup:userMenu(id)});}
        }

        if(isAdmin(id) && isAdminIn(id) && adminState[id]){
            const s = adminState[id];
            if(AB.includes(text)){ delete adminState[id]; }
            else if(s.action==="genkey"){const d=parseInt(text);if(isNaN(d)||d<1)return send(id,"❌ Days?");const k=generateKey(d,id);delete adminState[id];return send(id,"🔑 Key:\n\n"+k+"\n\n"+d+"d",{reply_markup:adminMenu});}
            else if(s.action==="adduser"){if(!s.step2){const t=parseInt(text);if(isNaN(t))return send(id,"❌");adminState[id]={action:"adduser",step2:true,tid:t};return send(id,"ID:"+t+"\nDays?");}else{const d=parseInt(text);if(isNaN(d)||d<1)return send(id,"❌");usersAccess[s.tid]=Date.now()+d*86400000;delete adminState[id];send(id,"✅ "+s.tid+" "+d+"d",{reply_markup:adminMenu});send(s.tid,"🎊 ACCESS! "+d+"d");return;}}
            else if(s.action==="removeuser"){const t=parseInt(text);if(isNaN(t))return;if(Number(t)===Number(OWNER_ID))return send(id,"❌ Owner access cannot be removed.",{reply_markup:adminMenu});const was=hasAccess(t);cleanupUserResources(t, true);delete adminState[id];send(id,was?"🚫 Removed":"⚠️ Not active",{reply_markup:adminMenu});if(was)send(t,"🔴 Removed.");return;}
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
            const targetProfit = Number(cfg.targetProfit) || 1000;
            return send(id,
"🤖 AUTOBET SETTINGS\n\n"+
"Status   : "+(cfg.enabled?"✅ ON":"❌ OFF")+"\n"+
"Token    : "+(getToken(id).length>20?"✅ SET":"❌ MISSING")+"\n"+
"AutoLogin: "+(creds.phone?"✅ "+creds.phone.slice(0,6)+"***":"❌ /setcreds  (or /setcredts)")+"\n"+
"Mode     : "+modeLabel(cfg.mode)+"\n"+
    (cfg.mode === "COMBINED" ? "Size Seq : ₹"+cfg.customSizeBets.join(" → ₹")+"\nNum Seq  : ₹"+cfg.customNumberBets.join(" → ₹")+"\nRule     : 1 site size + 1 site number\n" : "Bet Seq  : ₹"+cfg.customBets.join(" → ₹")+"\n")+
"Watch    : "+(cfg.watch?"ON":"OFF")+"\n"+
"WatchLoss: "+cfg.watchLoss+" consecutive\n"+
"Base Bet : ₹"+cfg.baseBet+"\n"+
"Max Level: "+cfg.maxLvl+"\n"+
"Target   : ₹"+targetProfit+"\n\n"+
formatMartingale(cfg)+"\n\n"+
"/setcreds 916381605525 PASSWORD  (or /setcredts)\n"+
"/setmytoken TOKEN",
            {reply_markup:autobetMenu});
        }

        if(text==="✅ Enable AutoBet"){
            const creds=userCreds[id]||{};
            if(!getToken(id))return send(id,"❌ Token இல்லை. முதலில் 🔐 Login press பண்ணி login complete பண்ணு.",{reply_markup:autobetMenu});
            autobetCfg[id].enabled=true;
            {
                send(id,"✅ AutoBet ON!\n₹"+autobetCfg[id].baseBet+" | Watch:"+(autobetCfg[id].watch?autobetCfg[id].watchLoss+"L":"OFF"),{reply_markup:userMenu(id)});
            }
            return;
        }
        if(text==="❌ Disable AutoBet"){autobetCfg[id].enabled=false;return send(id,"❌ AutoBet OFF",{reply_markup:userMenu(id)});}
        if(text==="👀 Watch Mode ON") {autobetCfg[id].watch=true;return send(id,"👀 Watch ON — "+autobetCfg[id].watchLoss+" losses → bet");}
        if(text==="👀 Watch Mode OFF"){autobetCfg[id].watch=false;return send(id,"👀 Watch OFF — Direct bet!");}
        if(text==="📈 Profit Plan ON") {
            userAction[id] = {action: "setprofitplaninput"};
            return send(id, "Enter max level:\nExample: 5\n\nThe actual wallet balance will be fetched automatically. Max level must be 1-10.");
        }
        if(text==="📉 Profit Plan OFF") {
            autobetCfg[id].profitPlan = autobetCfg[id].profitPlan || { enabled: false, startLevel: 1, currentLevel: 1 };
            autobetCfg[id].profitPlan.enabled = false;
            return send(id, "📉 Profit-based plan OFF", {reply_markup: autobetMenu});
        }
                        // --- CORRECTED SETTINGS HANDLERS ---
        if(text==="🎮 Mode: Big/Small"){
            delete userAction[id];
            autobetCfg[id].mode="SIZE";
            if (userStates[id]) { userStates[id].sizePredictionMode = 'ANALYSIS'; userStates[id].sizeOppositeActive = false; }
            return send(id,"✅ Mode set: BIG/SMALL\nAnalysis mode enabled; loss will use exact opposite prediction.",{reply_markup:autobetMenu});
        }
        if(text==="🎨 Mode: Color"){
            delete userAction[id];
            autobetCfg[id].mode="COLOR";
            return send(id,"✅ Mode set: COLOR\nCOLOR loss → SIZE NORMAL → SIZE RECOVERY → COLOR RECOVERY.",{reply_markup:autobetMenu});
        }
        if(text==="🔢 Mode: Number"){
            delete userAction[id];
            autobetCfg[id].mode="NUMBER";
            return send(id,"✅ Mode set: NUMBER\nExact Num_5 bet enabled.",{reply_markup:autobetMenu});
        }
        if(text==="🔀 Mode: BigSmall+Number"){
            delete userAction[id];
            autobetCfg[id].mode="COMBINED";
            return send(id,"✅ Mode set: BIG/SMALL + NUMBER\nOne site size bet + one site number bet.",{reply_markup:autobetMenu});
        }
        if(text==="💰 Set Base Bet"){userAction[id]={action:"setbase"};return send(id,"Enter base bet amount (e.g. 1):");}
        if(text==="📈 Set Max Level"){userAction[id]={action:"setlvl"};return send(id,"Enter max level (1-10):");}
        if(text==="🧠 Set Plan Level"){userAction[id]={action:"setprofitplanlevel"};return send(id,"Enter plan start level (1-10):");}
        if(text==="💹 Set Profit Switch"){
            userAction[id]={action:"setprofitswitch"};
            return send(id,"Enter profit switch amount in whole rupees:\nExample: 5 or 10\n\nThe plan switches after each cumulative profit step.");
        }
                // --- SETTINGS TRIGGERS ---
        if(text==="🎯 Set Profit Target"){userAction[id]={action:"settarget"};return send(id,"Enter target profit (Min ₹10):");}
        if(text==="⏳ Set Section Delay"){userAction[id]={action:"setdelay"};return send(id,"Enter restart delay in MINUTES (e.g. 30):");}
        if(text==="🔀 Customize Bet"){
            if (autobetCfg[id].mode === "COMBINED") {
                userAction[id]={action:"setcombinedcustom",step:"size"};
                return send(id,"Enter BIG/SMALL level amounts (example: 1,2,4,8):");
            }
            userAction[id]={action:"setsinglecustom",mode:autobetCfg[id].mode};
            return send(id, autobetCfg[id].mode === "NUMBER" ? "Enter NUMBER bet level amounts (example: 1,9,81,729):" : autobetCfg[id].mode === "COLOR" ? "Enter COLOR bet level amounts (example: 1,2,4,8):" : "Enter BIG/SMALL bet level amounts (example: 1,2,4,8):");
        }
if(text==="🔢 Set Watch Losses"){
    userAction[id]={action:"setwloss"};
    return send(id,"Enter watch loss count (e.g. 3):");
}

        // --- INPUT SAVING LOGIC ---
        if(hasAccess(id) && userAction[id]){
            const s = userAction[id];
            if(text === "🔙 Back") { delete userAction[id]; }
            
            else if(s.action === "setprofitplaninput"){
                const maxLevel = Number(text.trim().replace(/^\//, ""));
                if (!Number.isInteger(maxLevel) || maxLevel < 1 || maxLevel > 10) {
                    return send(id, "❌ Invalid max level. Enter a whole number from 1 to 10, for example: 5");
                }
                const balance = await getLiveBalance(id);
                if (!balance.success) return send(id, "❌ Could not fetch wallet balance: " + balance.message);
                const planBalance = Math.floor(Number(balance.balance));
                if (!Number.isFinite(planBalance) || planBalance <= 0 || planBalance < maxLevel) {
                    return send(id, "❌ Actual wallet balance ₹" + (Number.isFinite(planBalance) ? planBalance : 0) + " is too low for " + maxLevel + " levels.");
                }
                if (!autobetCfg[id].profitPlan) autobetCfg[id].profitPlan = { enabled: false, startLevel: 1, currentLevel: 1 };
                autobetCfg[id].profitPlan.enabled = true;
                autobetCfg[id].profitPlan.startLevel = 1;
                autobetCfg[id].profitPlan.currentLevel = 1;
                autobetCfg[id].profitPlan.planBalance = planBalance;
                autobetCfg[id].profitPlan.maxLevel = maxLevel;
                autobetCfg[id].maxLvl = maxLevel;
                syncProfitPlan(id, "enable", planBalance, maxLevel);
                delete userAction[id];
                return send(id, "✅ Profit plan ON\nActual balance: ₹" + planBalance.toFixed(2) + "\nMax level: L" + maxLevel, {reply_markup: autobetMenu});
            }
            else if(s.action === "setprofitswitch"){
                const step = Number(text.trim().replace(/^\//, ""));
                if (!Number.isInteger(step) || step <= 0) {
                    return send(id, "❌ Enter a whole positive amount, for example: 5 or 10");
                }
                if (!autobetCfg[id].profitPlan) autobetCfg[id].profitPlan = { enabled: false, startLevel: 1, currentLevel: 1 };
                autobetCfg[id].profitPlan.profitSwitchStep = step;
                autobetCfg[id].profitPlan.nextProfitSwitch = step;
                delete userAction[id];
                return send(id, "✅ Profit switch set to every ₹" + step + ".", {reply_markup: autobetMenu});
            }
            else if(s.action === "setprofitplanlevel"){
                const v = Number(text);
                if (!Number.isFinite(v) || v < 1 || v > 10) return send(id, "❌ Invalid plan level! Use 1-10.");
                if (!autobetCfg[id].profitPlan) autobetCfg[id].profitPlan = { enabled: false, startLevel: 1, currentLevel: 1 };
                autobetCfg[id].profitPlan.startLevel = v;
                autobetCfg[id].profitPlan.currentLevel = v;
                if (autobetCfg[id].profitPlan.enabled) await refreshWalletPlan(id, "level");
                delete userAction[id];
                return send(id, "✅ Profit plan started at L" + v + ".\nEach win updates the auto bet plan and syncs custom bets.", {reply_markup: autobetMenu});
            }
            else if(s.action === "settarget"){
                const v = Number(text);
                if(!Number.isFinite(v) || v < 10) return send(id, "❌ Min ₹10 kudunga!");
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
            else if(s.action === "setsinglecustom"){
                const vals = text.split(/[, ]+/).map(v => parseInt(v.trim())).filter(v => Number.isInteger(v) && v > 0);
                if(vals.length === 0) return send(id, "❌ Format error! Use: 1,2,4,8");
                autobetCfg[id].customBets = vals;
                if (s.mode === "NUMBER") autobetCfg[id].customNumberBets = [...vals];
                else autobetCfg[id].customSizeBets = [...vals];
                autobetCfg[id].maxLvl = vals.length;
                delete userAction[id];
                return send(id, "✅ "+(s.mode === "NUMBER" ? "NUMBER" : "BIG/SMALL")+" custom bets updated!\nSequence: ₹"+vals.join(" → ₹"), {reply_markup: autobetMenu});
            }
            else if(s.action === "setcombinedcustom"){
                const vals = text.split(/[, ]+/).map(v => parseInt(v.trim())).filter(v => Number.isInteger(v) && v > 0);
                if(vals.length === 0) return send(id, "❌ Format error! Use: 1,2,4,8");
                if(s.step === "size"){
                    autobetCfg[id].customSizeBets = vals;
                    userAction[id] = {action:"setcombinedcustom", step:"number", sizeVals:vals};
                    return send(id, "✅ Size levels saved. Now enter NUMBER level amounts (example: 1,9,81,729):");
                }
                autobetCfg[id].customNumberBets = vals;
                autobetCfg[id].maxLvl = Math.max((userAction[id].sizeVals || []).length, vals.length);
                delete userAction[id];
                return send(id, "✅ Combined custom bets updated!\nSize: ₹"+autobetCfg[id].customSizeBets.join(" → ₹")+"\nNumber: ₹"+vals.join(" → ₹")+"\nAny win resets both to L1.", {reply_markup: autobetMenu});
            }
            // ... matha setbase, setlvl code-um ithu kulla thaan varum
        }

        // --- IMPORTANT: AWAIT ADDED ---
        if(text==="📊 AutoBet Status") return await autobetStatus(msg.chat.id,id);

        if(text==="🔙 Back")return await send(id,"Main Menu",{reply_markup:userMenu(id)});

        if (text === "🔐 Login") {
            if (!hasAccess(id)) return send(id, "❌ No access.");

            const tok = getToken(id);
            const creds = userCreds[id] || {};
            const tokenStatus = tok && tok.length > 20 ? "✅ Saved (..." + tok.slice(-12) + ")" : "❌ Not saved";
            const credentialStatus = creds.phone ? "✅ Credentials saved" : "❌ First-time setup required";

            return send(id,
                "🔐 LOGIN\n\n" +
                "Token: " + tokenStatus + "\n" +
                "Credentials: " + credentialStatus + "\n\n" +
                "Choose an option:",
                {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "/setmytoken", callback_data: "login_menu_settoken" },
                            { text: "/login", callback_data: "login_menu_login" }
                        ]]
                    }
                }
            );
        }

        if(text==="⏹ Stop Prediction"){
            if(!running[id]) return send(msg.chat.id,"⚠️ Bot is not running.",{reply_markup:userMenu(id)});
            running[id]=false;
            clearUserTimers(id);
            return send(msg.chat.id,"⏹ Prediction stopped. No new bets or result checks will be scheduled.",{reply_markup:userMenu(id)});
        }

      if(text==="▶️ Start Prediction"){
            if(!hasAccess(id))return send(msg.chat.id,"❌ No access!\n📩 "+ADMIN_HANDLE+"\nID: "+id);
            if(running[id])return send(msg.chat.id,"⚠️ Already running!");

            clearUserTimers(id);
            running[id]=true;sentPeriods[id]=new Set();
            predictionDispatches.set(String(id), new Set());
            settledPeriods.delete(String(id));
            autobetState[id]={...(autobetState[id]||{}),level:1,sizeLevel:1,numberLevel:1,consecutiveLoss:0,inMart:false,lastWinLevel:null,lastWinMode:null,waitingForWatchWin:false,lastOutcome:null};

            // Load previous B/S history from API
            const prevList = await fetchList();
            initState(id);

            if (prevList && prevList.length >= 4) {
                // Build B/S history
                userStates[id].resultHistory = buildBSFromList(prevList, 15);
                await send(msg.chat.id, "📋 Loaded history: " + (userStates[id].resultHistory || []).join(''));


            }

            const cfg=autobetCfg[id];
            await send(msg.chat.id,
"🚀 ENGINE ON!\n\nAutoBet: "+(cfg.enabled?"✅ ON":"❌ OFF")+"\nMode   : "+modeLabel(cfg.mode)+"\nWatch  : "+(cfg.watch?"ON ("+cfg.watchLoss+"L)":"OFF")+"\nBase   : ₹"+cfg.baseBet+" | MaxLvl: "+cfg.maxLvl
            );
            runPredict(id,msg.chat.id);
        }
        if(text==="📊 Stats")  showStats(msg.chat.id,id);
        if(text==="💰 Profit") profitReport(msg.chat.id,id);
        if(text==="📩 Contact") send(msg.chat.id,"📩 "+ADMIN_HANDLE+"\nID: "+id);
    });
}
const shutdown = async (signal) => {
    console.log(`[SHUTDOWN] ${signal}`);
    for (const id of Object.keys(running)) { running[id] = false; clearUserTimers(id); }
    try { if (bot) await bot.stopPolling(); } catch {}
    process.exit(0);
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
startBot();
