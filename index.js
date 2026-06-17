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
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT     = 3;   // 3 سے زیادہ ہوں تو bundle بنے
const DAILY_MAX      = 10;

// ══════════════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE
// ══════════════════════════════════════════════════════════════════════════
const dailyCountCache = new Map();
const rateWindowCache = new Map();
const chatLockCache   = new Map();
const postSentCache   = new Set();

setInterval(() => {
    const now = Date.now();
    for (const [key, entries] of rateWindowCache) {
        const filtered = entries.filter(e => e.ts > now - RATE_WINDOW_MS);
        if (filtered.length === 0) rateWindowCache.delete(key);
        else rateWindowCache.set(key, filtered);
    }
    for (const [key, ts] of chatLockCache) {
        if (now - ts > 10000) chatLockCache.delete(key);
    }
    if (postSentCache.size > 1000) postSentCache.clear();
    console.log(`Cache: Daily:${dailyCountCache.size} Rate:${rateWindowCache.size} Chat:${chatLockCache.size} Posts:${postSentCache.size}`);
}, 5 * 60 * 1000);

setInterval(() => {
    dailyCountCache.clear();
    console.log("Daily count cache reset");
}, 60 * 60 * 1000);

// ─── Health Check ──────────────────────────────────────────────────────────
app.get('/',           (req, res) => res.send("✅ Health Jobs API is Live!"));
app.get('/api/server', (req, res) => res.send("✅ API is Live!"));


// ══════════════════════════════════════════════════════════════════════════
// HELPER: HTML اور ایموجی صاف کرو
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
// HELPER: Valid icon یا logo
// ══════════════════════════════════════════════════════════════════════════
function getIcon(photo) {
    return photo && photo.startsWith('http') ? photo : LOGO_URL;
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: Daily limit check
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
// HELPER: Rate window check
// ══════════════════════════════════════════════════════════════════════════
function checkRateLimit(uid, postEntry) {
    if (!uid) return { shouldBundle: false };
    const nowMs  = Date.now();
    const cutoff = nowMs - RATE_WINDOW_MS;
    let entries  = rateWindowCache.get(uid) || [];
    entries      = entries.filter(e => e.ts > cutoff);
    entries.push({ ts: nowMs, ...postEntry });
    rateWindowCache.set(uid, entries);
    if (entries.length > RATE_LIMIT) {
        return { shouldBundle: true, count: entries.length, posts: entries };
    }
    return { shouldBundle: false };
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: Post dedup
// ══════════════════════════════════════════════════════════════════════════
function acquirePostLockMem(postId) {
    if (!postId) return false;
    if (postSentCache.has(String(postId))) return false;
    postSentCache.add(String(postId));
    return true;
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: Chat dedup
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
// HELPER: Invalid tokens Firestore سے remove کرو
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
// HELPER: Single user token لو
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
//
// مسائل جو ٹھیک کیے:
// 1. ہر یوزر کو صرف ایک نوٹیفکیشن — tag: `post_${postId}` سے enforce
// 2. نوٹیفکیشن clickable — webpush.fcmOptions.link صحیح URL پر
// 3. Grouped notifications — tag ایک ہو تو browser خود group بناتا ہے
// 4. Icon: poster کی photo (senderPhoto) — اگر نہیں تو logo
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/server', async (req, res) => {
    try {
        const { title, hospital, body, postId, postSlug, senderPhoto, posterId } = req.body;
        console.log("Post Notification:", { postId, posterId });

        if (!postId) return res.status(400).json({ success: false, message: "postId is required" });

        // ✅ Dedup — ایک پوسٹ کا صرف ایک نوٹیفکیشن
        const locked = acquirePostLockMem(postId);
        if (!locked) {
            console.log("Duplicate suppressed:", postId);
            return res.status(200).json({ success: false, message: "Notification already sent" });
        }

        // ─── Post URL بناؤ ────────────────────────────────────────────
        const postPath = postSlug ? `post/${postSlug}` : `details.html?id=${postId}`;
        const clickUrl = `${BASE_URL}/${postPath}`;

        const cleanTitle    = stripHtml(title)    || 'New Post';
        const cleanHospital = stripHtml(hospital) || 'Health Jobs';
        const cleanBody     = stripHtml(body)     || 'Tap to view.';
        const posterIcon    = getIcon(senderPhoto); // ✅ poster کی پک

        // ─── سب users کے tokens لو ────────────────────────────────────
        const usersSnap = await db.collection('users').get();
        const userMap   = new Map();
        usersSnap.forEach(doc => {
            if (posterId && doc.id === posterId) return; // poster کو نوٹیفکیشن نہیں
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
            if (!checkDailyLimit(uid)) { console.log(`Daily limit: ${uid}`); continue; }

            const { shouldBundle, count, posts } = checkRateLimit(uid, postEntry);
            let msg;

            if (shouldBundle) {
                // ─── Bundle: زیادہ posts ─────────────────────────────────
                // tag: `bundle_${uid}` → ہر user کا اپنا bundle tag
                // browser grouped notification دکھائے گا
                const names    = [...new Set(posts.map(p => p.poster))].slice(0, 2).join(', ');
                const bundleUrl = `${BASE_URL}/index.html`;
                msg = {
                    notification: {
                        title: `${count} New Posts on Health Jobs Portal`,
                        body:  `${names}${count > 2 ? ` & ${count - 2} others` : ''} posted new jobs`
                    },
                    webpush: {
                        notification: {
                            icon:               LOGO_URL,
                            badge:              LOGO_URL,
                            requireInteraction: false,
                            // ✅ ایک tag → browser پرانا replace کرے گا (صرف ایک رہے)
                            tag:                `bundle_${uid}`,
                            renotify:           true,
                        },
                        // ✅ CLICK کرنے پر index.html کھلے گا
                        fcmOptions: { link: bundleUrl },
                        // ✅ Web push standard click action
                        headers:    { Urgency: 'normal' }
                    },
                    android: {
                        priority: 'high',
                        notification: {
                            icon:         'ic_notification',
                            color:        '#0a66c2',
                            channel_id:   'high_importance_channel',
                            click_action: 'FLUTTER_NOTIFICATION_CLICK'
                        }
                    },
                    data: {
                        type:     'bundle',
                        count:    String(count),
                        clickUrl: bundleUrl
                    },
                    tokens
                };
            } else {
                // ─── Single post notification ────────────────────────────
                // tag: `post_${postId}` → سب users کیلئے ایک ہی tag
                // یعنی ہر user کو صرف ایک نوٹیفکیشن آئے گا اس post کا
                const notifTitle = `${cleanHospital}: ${cleanTitle}`;
                const notifBody  = cleanBody.length > 120
                    ? cleanBody.substring(0, 120) + '...'
                    : cleanBody;

                msg = {
                    notification: {
                        title: notifTitle,
                        body:  notifBody
                    },
                    webpush: {
                        notification: {
                            icon:               posterIcon,   // ✅ poster کی photo
                            badge:              LOGO_URL,
                            requireInteraction: false,
                            // ✅ ایک post کا ایک ہی tag → duplicate نہیں آئے گا
                            tag:                `post_${postId}`,
                            renotify:           false,        // same tag پر دوبارہ buzz نہیں
                        },
                        // ✅ CLICK → سیدھا post پر جائے
                        fcmOptions: { link: clickUrl },
                        headers:    { Urgency: 'normal' }
                    },
                    android: {
                        priority: 'high',
                        notification: {
                            icon:         'ic_notification',
                            color:        '#0a66c2',
                            channel_id:   'high_importance_channel',
                            click_action: 'FLUTTER_NOTIFICATION_CLICK'
                        }
                    },
                    data: {
                        type:     'general_post',
                        postId:   String(postId),
                        postSlug: String(postSlug || postId),
                        clickUrl: clickUrl
                    },
                    tokens
                };
            }

            const response = await admin.messaging().sendEachForMulticast(msg);
            totalSent   += response.successCount;
            totalFailed += response.failureCount;
            tokens.forEach(t => allTokensUsed.push(t));
            response.responses.forEach(r => allResponses.push(r));
        }

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

        if (!acquireChatLockMem(senderUid, receiverUid)) {
            return res.status(200).json({ success: false, message: "Duplicate suppressed" });
        }

        let token = targetToken;
        if (!token && receiverUid) {
            token = await getUserToken(receiverUid);
        }

        if (!token)     return res.status(400).json({ error: "No FCM token" });
        if (!senderUid) return res.status(400).json({ error: "senderUid required" });

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
                notification: {
                    icon:               getIcon(senderPhoto),
                    badge:              LOGO_URL,
                    requireInteraction: false,
                    tag:                `chat_${senderUid}`,
                    renotify:           true
                },
                // ✅ CLICK → chat کھلے
                fcmOptions: { link: clickUrl },
                headers:    { Urgency: 'high' }
            },
            android: {
                priority: 'high',
                notification: {
                    icon:         'ic_notification',
                    color:        '#0a66c2',
                    channel_id:   'high_importance_channel',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                }
            },
            data: {
                type:      'chat_message',
                senderUid: String(senderUid),
                clickUrl:  clickUrl
            },
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
            await admin.messaging().send({
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

        await admin.messaging().send({
            notification: { title: cleanCallerName, body: callText },
            webpush: {
                notification: {
                    icon:               getIcon(callerPhoto),
                    badge:              LOGO_URL,
                    requireInteraction: true,  // call پر dismiss نہ ہو
                    tag:                `call_${callerUid}`,
                    vibrate:            [200, 100, 200, 100, 200]
                },
                // ✅ CLICK → call screen کھلے
                fcmOptions: { link: clickUrl },
                headers:    { TTL: '30', Urgency: 'high' }
            },
            android: {
                priority: 'high',
                ttl:      30000,
                notification: {
                    icon:         'ic_notification',
                    color:        '#0a66c2',
                    channel_id:   'high_importance_channel',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK',
                    tag:          `call_${callerUid}`
                }
            },
            data: {
                isCall:     'true',
                callerUid:  String(callerUid || ''),
                callerName: cleanCallerName,
                callType:   String(callType || 'audio'),
                clickUrl:   clickUrl
            },
            token: targetToken
        });

        console.log("Call notification sent");
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

        if (!checkDailyLimit(`reaction_${postOwnerId}`)) {
            return res.status(200).json({ success: false, message: "Daily limit" });
        }

        const token = await getUserToken(postOwnerId);
        if (!token) return res.status(200).json({ success: false, message: "No token" });

        const postPath   = postSlug ? `post/${postSlug}` : `details.html?id=${postId}`;
        const clickUrl   = `${BASE_URL}/${postPath}`;
        const cleanActor = stripHtml(actorName) || 'Someone';
        const cleanTitle = stripHtml(postTitle);
        const cleanCmnt  = stripHtml(commentPreview);
        const pTitle     = cleanTitle ? `"${cleanTitle}"` : 'your post';

        let notifTitle, notifBody;
        if (type === 'like') {
            notifTitle = `${cleanActor} liked your post`;
            notifBody  = cleanTitle ? `${cleanActor} liked "${cleanTitle}"` : `${cleanActor} liked your post`;
        } else {
            notifTitle = `${cleanActor} commented on your post`;
            notifBody  = cleanCmnt
                ? `${cleanActor}: ${cleanCmnt.length > 80 ? cleanCmnt.substring(0, 80) + '...' : cleanCmnt}`
                : `${cleanActor} commented on ${pTitle}`;
        }

        await admin.messaging().send({
            notification: { title: notifTitle, body: notifBody },
            webpush: {
                notification: {
                    icon:               getIcon(actorPhoto),
                    badge:              LOGO_URL,
                    requireInteraction: false,
                    tag:                `${type}_${postId}_${actorUid || Date.now()}`,
                    renotify:           true
                },
                // ✅ CLICK → post پر جاؤ
                fcmOptions: { link: clickUrl },
                headers:    { Urgency: 'normal' }
            },
            android: {
                priority: 'normal',
                notification: {
                    icon:         'ic_notification',
                    color:        '#e91e63',
                    channel_id:   'high_importance_channel',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                }
            },
            data: {
                type:     `reaction_${type}`,
                postId:   String(postId || ''),
                actorUid: String(actorUid || ''),
                clickUrl: clickUrl
            },
            token
        });

        console.log(`${type} notification sent`);
        return res.status(200).json({ success: true, type });

    } catch (error) {
        console.error("Reaction Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 5 — /api (legacy call route)
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
        const clickUrl  = `${BASE_URL}/chat.html?uid=${callerUid}&startCall=true&callType=${callType || 'audio'}&incoming=true`;
        const callText  = callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';

        await admin.messaging().send({
            notification: { title: cleanCallerName, body: callText },
            webpush: {
                notification: {
                    icon:               getIcon(callerPhoto),
                    badge:              LOGO_URL,
                    requireInteraction: true,
                    tag:                `call_${callerUid}`
                },
                fcmOptions: { link: clickUrl },
                headers:    { TTL: '30', Urgency: 'high' }
            },
            android: {
                priority: 'high',
                ttl:      30000,
                notification: {
                    icon:         'ic_notification',
                    color:        '#0a66c2',
                    channel_id:   'high_importance_channel',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                }
            },
            data: {
                isCall:     'true',
                callerUid:  String(callerUid || ''),
                callerName: cleanCallerName,
                callType:   String(callType || 'audio'),
                clickUrl:   clickUrl
            },
            token: targetToken
        });
        return res.status(200).json({ success: true, type: 'call' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});


export default app;
