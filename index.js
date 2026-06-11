import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';

const app = express();

// ─── Firebase Admin Init ───────────────────────────────────────────────────
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("✅ Firebase Admin Initialized");
    } catch (error) {
        console.error("❌ Firebase Admin Init Error:", error.message);
    }
}
const db = admin.firestore();

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Constants ────────────────────────────────────────────────────────────
const BASE_URL       = 'https://healthjobs-portal.web.app';
const LOGO_URL       = `${BASE_URL}/images/logo.png`;
const RATE_WINDOW_MS = 10 * 60 * 1000;  // 10 منٹ
const RATE_LIMIT     = 5;
const DAILY_MAX      = 10;

// ══════════════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE — Firestore costs بچانے کیلئے
// ══════════════════════════════════════════════════════════════════════════
// NOTE: Vercel/serverless میں یہ cache request کے درمیان survive نہیں کرے گا
// اگر آپ کو exact limits چاہیے تو Redis use کریں، ورنہ یہ acceptable ہے
// کیونکہ FCM خود بھی rate limit کرتا ہے

const dailyCountCache = new Map();    // key: `${uid}_${date}` → count
const rateWindowCache = new Map();    // key: uid → [{ts, ...}]
const chatLockCache   = new Map();    // key: lockKey → timestamp
const postSentCache   = new Set();    // postIds جو بھیجے جا چکے

// ─── Periodic cache cleanup ────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    
    // Rate window cache clean
    for (const [key, entries] of rateWindowCache) {
        const filtered = entries.filter(e => e.ts > now - RATE_WINDOW_MS);
        if (filtered.length === 0) {
            rateWindowCache.delete(key);
        } else {
            rateWindowCache.set(key, filtered);
        }
    }
    
    // Chat lock cache clean (5s سے پرانے delete)
    for (const [key, ts] of chatLockCache) {
        if (now - ts > 10000) chatLockCache.delete(key);
    }
    
    // Post sent cache clean (1 گھنٹے سے پرانے delete)
    // postSentCache کو size limit کیلئے clean کرتے ہیں
    if (postSentCache.size > 1000) {
        postSentCache.clear();
    }
    
    console.log(`Cache stats - Daily:${dailyCountCache.size}, Rate:${rateWindowCache.size}, Chat:${chatLockCache.size}, Posts:${postSentCache.size}`);
}, 5 * 60 * 1000); // ہر 5 منٹ بعد

// Midnight cache reset for daily counts
setInterval(() => {
    dailyCountCache.clear();
    console.log("Daily count cache reset at midnight");
}, 60 * 60 * 1000); // ہر گھنٹے چیک (effective midnight reset approximate)

// ─── Health Check ──────────────────────────────────────────────────────────
app.get('/',           (req, res) => res.send("✅ Health Jobs API is Live!"));
app.get('/api/server', (req, res) => res.send("✅ API is Live!"));


// ══════════════════════════════════════════════════════════════════════════
// HELPER: HTML tags، entities اور ایموجیز صاف کرو
// ══════════════════════════════════════════════════════════════════════════
function stripHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
        .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
        .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
        .replace(/[\u{1F700}-\u{1F77F}]/gu, '')
        .replace(/[\u{1F780}-\u{1F7FF}]/gu, '')
        .replace(/[\u{1F800}-\u{1F8FF}]/gu, '')
        .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
        .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')
        .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')
        .replace(/[\u{2600}-\u{26FF}]/gu, '')
        .replace(/[\u{2700}-\u{27BF}]/gu, '')
        .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
        .replace(/[\u{200D}]/gu, '')
        .replace(/[^\x20-\x7E\u00A0-\u024F\u0400-\u04FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: valid icon URL یا logo fallback
// ══════════════════════════════════════════════════════════════════════════
function getIcon(photo) {
    return photo && photo.startsWith('http') ? photo : LOGO_URL;
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: In-memory daily count (Firestore transaction کی بجائے)
// ══════════════════════════════════════════════════════════════════════════
function checkDailyLimit(uid) {
    if (!uid) return true;
    const today = new Date().toISOString().split('T')[0];
    const key   = `${uid}_${today}`;
    const count = dailyCountCache.get(key) || 0;
    if (count >= DAILY_MAX) return false;
    dailyCountCache.set(key, count + 1);
    return true;
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: In-memory rate window check (Firestore transaction کی بجائے)
// ══════════════════════════════════════════════════════════════════════════
function checkRateLimit(uid, postEntry) {
    if (!uid) return { shouldBundle: false };
    const nowMs   = Date.now();
    const cutoff  = nowMs - RATE_WINDOW_MS;
    let entries   = rateWindowCache.get(uid) || [];
    entries       = entries.filter(e => e.ts > cutoff);
    entries.push({ ts: nowMs, ...postEntry });
    rateWindowCache.set(uid, entries);
    if (entries.length > RATE_LIMIT) {
        return { shouldBundle: true, count: entries.length, posts: entries };
    }
    return { shouldBundle: false };
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: In-memory post deduplication (Firestore transaction کی بجائے)
// ══════════════════════════════════════════════════════════════════════════
function acquirePostLockMem(postId) {
    if (!postId) return false;
    if (postSentCache.has(String(postId))) return false;
    postSentCache.add(String(postId));
    return true;
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: In-memory chat deduplication (Firestore transaction کی بجائے)
// ══════════════════════════════════════════════════════════════════════════
function acquireChatLockMem(senderUid, receiverUid) {
    if (!senderUid || !receiverUid) return true;
    const window5s = Math.floor(Date.now() / 5000);
    const lockKey  = `chat_${senderUid}_${receiverUid}_${window5s}`;
    if (chatLockCache.has(lockKey)) return false;
    chatLockCache.set(lockKey, Date.now());
    return true;
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: Invalid tokens کو Firestore سے remove کرنا (ضروری Firestore call)
// ══════════════════════════════════════════════════════════════════════════
async function removeInvalidTokens(responses, tokens) {
    const batch   = db.batch();
    let removed   = 0;
    const badCodes = [
        'messaging/invalid-registration-token',
        'messaging/registration-token-not-registered'
    ];
    for (let i = 0; i < responses.length; i++) {
        const resp = responses[i];
        if (!resp.success && badCodes.includes(resp.error?.code)) {
            try {
                const snap = await db.collection('users').where('fcmToken', '==', tokens[i]).get();
                snap.forEach(doc => {
                    batch.update(doc.ref, { fcmToken: admin.firestore.FieldValue.delete() });
                    removed++;
                });
            } catch (_) {}
        }
    }
    if (removed > 0) {
        await batch.commit();
        console.log(`Removed ${removed} invalid token(s)`);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: Get single user token (chat/reaction کیلئے)
// ══════════════════════════════════════════════════════════════════════════
async function getUserToken(uid) {
    if (!uid) return null;
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) return null;
    const raw = doc.data().fcmToken;
    return Array.isArray(raw) ? raw[0] : raw;
}


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 1 — POST NOTIFICATION  (/api/server)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/server', async (req, res) => {
    try {
        const { title, hospital, body, postId, postSlug, senderPhoto, posterId } = req.body;
        console.log("Post Notification:", { postId, posterId });

        if (!postId) return res.status(400).json({ success: false, message: "postId is required" });

        // ✅ In-memory dedup — ZERO Firestore cost
        const locked = acquirePostLockMem(postId);
        if (!locked) {
            console.log("Duplicate suppressed:", postId);
            return res.status(200).json({ success: false, message: "Notification already sent" });
        }

        const postPath = postSlug ? `post/${postSlug}` : `details.html?id=${postId}`;
        const clickUrl = `${BASE_URL}/${postPath}`;

        const cleanTitle    = stripHtml(title)    || 'New Post';
        const cleanHospital = stripHtml(hospital) || 'Health Jobs';
        const cleanBody     = stripHtml(body)     || 'Tap to view.';

        // ⚠️ ONLY Firestore read — all users tokens (unavoidable)
        const usersSnap = await db.collection('users').get();
        const userMap = new Map();
        usersSnap.forEach(doc => {
            if (posterId && doc.id === posterId) return;
            const data = doc.data();
            const raw  = data.fcmToken;
            if (!raw) return;
            const tokens = (Array.isArray(raw) ? raw : [raw]).filter(t => t && t.length > 10);
            if (tokens.length > 0) userMap.set(doc.id, { tokens });
        });

        console.log("Users to notify:", userMap.size);
        if (userMap.size === 0) return res.status(200).json({ success: false, message: "No users to notify" });

        const postEntry = {
            postId,
            title:  cleanTitle,
            poster: cleanHospital,
            photo:  senderPhoto || LOGO_URL,
            url:    clickUrl
        };

        let totalSent = 0, totalFailed = 0;
        const allTokensUsed = [], allResponses = [];

        for (const [uid, { tokens }] of userMap) {
            // ✅ In-memory check — ZERO Firestore cost
            if (!checkDailyLimit(uid)) { console.log(`Daily limit: ${uid}`); continue; }
            
            // ✅ In-memory check — ZERO Firestore cost
            const { shouldBundle, count, posts } = checkRateLimit(uid, postEntry);
            let msg;

            if (shouldBundle) {
                const names = [...new Set(posts.map(p => p.poster))].slice(0, 3).join(', ');
                msg = {
                    notification: {
                        title: `${count} New Posts on Health Jobs`,
                        body: `${count} new posts from ${names}${count > 3 ? ' & others' : ''}`
                    },
                    webpush: {
                        notification: { icon: LOGO_URL, badge: LOGO_URL, requireInteraction: false, tag: `bundle_${uid}`, renotify: true },
                        fcmOptions: { link: `${BASE_URL}/index.html` }
                    },
                    android: {
                        priority: 'high',
                        notification: { icon: 'ic_notification', color: '#0a66c2', channel_id: 'high_importance_channel', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
                    },
                    data: { type: 'bundle', count: String(count), clickUrl: `${BASE_URL}/index.html` },
                    tokens
                };
            } else {
                const notifTitle = `${cleanHospital}: ${cleanTitle}`;
                const notifBody  = cleanBody.length > 120 ? cleanBody.substring(0, 120) + '...' : cleanBody;
                msg = {
                    notification: { title: notifTitle, body: notifBody },
                    webpush: {
                        notification: { icon: getIcon(senderPhoto), badge: LOGO_URL, requireInteraction: false, tag: `post_${postId}` },
                        fcmOptions: { link: clickUrl }
                    },
                    android: {
                        priority: 'high',
                        notification: { icon: 'ic_notification', color: '#0a66c2', channel_id: 'high_importance_channel', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
                    },
                    data: { postId, type: 'general_post', clickUrl },
                    tokens
                };
            }

            const response = await admin.messaging().sendEachForMulticast(msg);
            totalSent   += response.successCount;
            totalFailed += response.failureCount;
            tokens.forEach(t => allTokensUsed.push(t));
            response.responses.forEach(r => allResponses.push(r));
        }

        // ⚠️ Only if there are failures — Firestore write to remove bad tokens
        if (allResponses.some(r => !r.success)) {
            await removeInvalidTokens(allResponses, allTokensUsed);
        }

        return res.status(200).json({ success: true, sent: totalSent, failed: totalFailed });

    } catch (error) {
        console.error("Post Notification Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 2 — CHAT MESSAGE NOTIFICATION  (/api/chat)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
    try {
        const { receiverUid, targetToken, senderName, senderUid, senderPhoto, messagePreview } = req.body;
        console.log("Chat Notification:", { senderUid, receiverUid });

        // ✅ In-memory dedup — ZERO Firestore cost
        if (!acquireChatLockMem(senderUid, receiverUid)) {
            return res.status(200).json({ success: false, message: "Duplicate suppressed" });
        }

        let token = targetToken;
        if (!token && receiverUid) {
            token = await getUserToken(receiverUid); // ⚠️ 1 Firestore read
        }

        if (!token)     return res.status(400).json({ error: "No FCM token" });
        if (!senderUid) return res.status(400).json({ error: "senderUid required" });

        // ✅ In-memory check
        const limitKey = receiverUid || token.substring(0, 20);
        if (!checkDailyLimit(`chat_${limitKey}`)) {
            return res.status(200).json({ success: false, message: "Daily limit" });
        }

        const cleanPreview = stripHtml(messagePreview);
        const cleanSender  = stripHtml(senderName) || 'Healthcare User';
        const notifBody    = cleanPreview
            ? (cleanPreview.length > 80 ? cleanPreview.substring(0, 80) + '...' : cleanPreview)
            : 'You have a new message. Tap to reply.';
        const clickUrl = `${BASE_URL}/chat.html?uid=${senderUid}`;

        const message = {
            notification: { title: cleanSender, body: notifBody },
            webpush: {
                notification: { icon: getIcon(senderPhoto), badge: LOGO_URL, requireInteraction: false, tag: `chat_${senderUid}`, renotify: true },
                fcmOptions: { link: clickUrl }
            },
            android: {
                priority: 'high',
                notification: { icon: 'ic_notification', color: '#0a66c2', channel_id: 'high_importance_channel', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
            },
            data: { type: 'chat_message', senderUid: String(senderUid), clickUrl },
            token
        };

        const r = await admin.messaging().send(message);
        console.log("Chat sent:", r);
        return res.status(200).json({ success: true, type: 'chat' });

    } catch (error) {
        console.error("Chat Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 3 — CALL NOTIFICATION  (/api/call)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/call', async (req, res) => {
    try {
        const { targetToken, callerName, callerUid, callerPhoto, callType, action } = req.body;
        console.log("Call:", { callerUid, action });

        if (!targetToken) return res.status(400).json({ error: "targetToken required" });

        if (action === 'cancel') {
            const r = await admin.messaging().send({
                data: { action: 'cancel_call', callerUid: String(callerUid || '') },
                android: { priority: 'high', ttl: 10000 },
                webpush: { headers: { TTL: '10' } },
                token: targetToken
            });
            return res.status(200).json({ success: true, type: 'cancel' });
        }

        const clickUrl        = `${BASE_URL}/chat.html?uid=${callerUid}&startCall=true&callType=${callType || 'audio'}&incoming=true`;
        const cleanCallerName = stripHtml(callerName) || 'Health Jobs User';
        const callText        = callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';

        const r = await admin.messaging().send({
            notification: { title: cleanCallerName, body: callText },
            webpush: {
                notification: { icon: getIcon(callerPhoto), badge: LOGO_URL, requireInteraction: true, tag: `call_${callerUid}`, vibrate: [200, 100, 200, 100, 200] },
                fcmOptions: { link: clickUrl },
                headers: { TTL: '30' }
            },
            android: {
                priority: 'high', ttl: 30000,
                notification: { icon: 'ic_notification', color: '#0a66c2', channel_id: 'high_importance_channel', click_action: 'FLUTTER_NOTIFICATION_CLICK', tag: `call_${callerUid}` }
            },
            data: { isCall: 'true', callerUid: String(callerUid || ''), callerName: cleanCallerName, callType: String(callType || 'audio'), clickUrl },
            token: targetToken
        });

        console.log("Call sent:", r);
        return res.status(200).json({ success: true, type: 'call' });

    } catch (error) {
        console.error("Call Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 4 — LIKE / COMMENT NOTIFICATION  (/api/reaction)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/reaction', async (req, res) => {
    try {
        const { type, postId, postSlug, postTitle, postOwnerId, actorName, actorUid, actorPhoto, commentPreview } = req.body;
        console.log("Reaction:", { type, postOwnerId, actorUid });

        if (!postOwnerId) return res.status(400).json({ error: "postOwnerId required" });
        if (!type || !['like', 'comment'].includes(type)) return res.status(400).json({ error: "type must be like/comment" });
        if (actorUid && actorUid === postOwnerId) return res.status(200).json({ success: false, message: "Self-reaction" });

        // ✅ In-memory check
        if (!checkDailyLimit(`reaction_${postOwnerId}`)) {
            return res.status(200).json({ success: false, message: "Daily limit" });
        }

        const token = await getUserToken(postOwnerId); // ⚠️ 1 Firestore read
        if (!token) return res.status(200).json({ success: false, message: "No token" });

        const postPath  = postSlug ? `post/${postSlug}` : `details.html?id=${postId}`;
        const clickUrl  = `${BASE_URL}/${postPath}`;
        const cleanActor = stripHtml(actorName) || 'Someone';
        const cleanTitle = stripHtml(postTitle);
        const cleanCmnt  = stripHtml(commentPreview);
        const pTitle     = cleanTitle ? `"${cleanTitle}"` : 'your post';

        let notifTitle, notifBody;
        if (type === 'like') {
            notifTitle = `${cleanActor} liked your post`;
            notifBody  = `${cleanActor} liked ${pTitle}`;
        } else {
            notifTitle = `${cleanActor} commented on your post`;
            notifBody  = cleanCmnt
                ? `${cleanActor}: ${cleanCmnt.length > 80 ? cleanCmnt.substring(0, 80) + '...' : cleanCmnt}`
                : `${cleanActor} commented on ${pTitle}`;
        }

        const r = await admin.messaging().send({
            notification: { title: notifTitle, body: notifBody },
            webpush: {
                notification: { icon: getIcon(actorPhoto), badge: LOGO_URL, requireInteraction: false, tag: `${type}_${postId}_${actorUid || Date.now()}`, renotify: true },
                fcmOptions: { link: clickUrl }
            },
            android: {
                priority: 'normal',
                notification: { icon: 'ic_notification', color: '#e91e63', channel_id: 'high_importance_channel', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
            },
            data: { type: `reaction_${type}`, postId: String(postId || ''), actorUid: String(actorUid || ''), clickUrl },
            token
        });

        console.log(`${type} sent:`, r);
        return res.status(200).json({ success: true, type });

    } catch (error) {
        console.error("Reaction Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 5 — /api (legacy)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api', async (req, res) => {
    const { targetToken, callerName, callerUid, callerPhoto, callType, action } = req.body;
    if (!targetToken) return res.status(400).json({ error: "targetToken required" });

    if (action === 'cancel') {
        try {
            await admin.messaging().send({
                data: { action: 'cancel_call', callerUid: String(callerUid || '') },
                android: { priority: 'high', ttl: 10000 },
                webpush: { headers: { TTL: '10' } },
                token: targetToken
            });
            return res.status(200).json({ success: true, type: 'cancel' });
        } catch (e) { return res.status(500).json({ error: e.message }); }
    }

    try {
        const cleanCallerName = stripHtml(callerName) || 'Health Jobs User';
        const clickUrl = `${BASE_URL}/chat.html?uid=${callerUid}&startCall=true&callType=${callType || 'audio'}&incoming=true`;
        const callText = callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';

        await admin.messaging().send({
            notification: { title: cleanCallerName, body: callText },
            webpush: {
                notification: { icon: getIcon(callerPhoto), badge: LOGO_URL, requireInteraction: true, tag: `call_${callerUid}` },
                fcmOptions: { link: clickUrl },
                headers: { TTL: '30' }
            },
            android: {
                priority: 'high', ttl: 30000,
                notification: { icon: 'ic_notification', color: '#0a66c2', channel_id: 'high_importance_channel', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
            },
            data: { isCall: 'true', callerUid: String(callerUid || ''), callerName: cleanCallerName, callType: String(callType || 'audio'), clickUrl },
            token: targetToken
        });
        return res.status(200).json({ success: true, type: 'call' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});


export default app;
