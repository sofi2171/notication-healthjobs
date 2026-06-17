import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';

const app = express();

// ─── Firebase Admin Init ───────────────────────────────────────────────────
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
        console.log("Firebase Admin Initialized");
    } catch (error) {
        console.error("Firebase Admin Init Error:", error.message);
    }
}
const db = admin.firestore();

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Constants ────────────────────────────────────────────────────────────
const BASE_URL        = 'https://healthjobs-portal.web.app';
const LOGO_URL        = `${BASE_URL}/images/logo.png`;
const NOTIF_PAGE      = `${BASE_URL}/notifications.html`;

const RATE_WINDOW_MS  = 10 * 60 * 1000;   // 10 منٹ
const RATE_LIMIT      = 3;                 // 3 سے زیادہ ہوں تو bundle
const DAILY_MAX       = 10;

const LIKE_COOLDOWN_MS   = 6 * 60 * 60 * 1000;  // 6 گھنٹے
const REACTION_GROUP_MS  = 30 * 1000;            // 30 سیکنڈ
const CHAT_GROUP_MS      = 60 * 1000;            // 60 سیکنڈ - chat grouping window
const CHAT_GROUP_MIN     = 3;                    // 3 یا زیادہ messages پر group بنے

// ══════════════════════════════════════════════════════════════════════════
// IN-MEMORY CACHE
// ══════════════════════════════════════════════════════════════════════════
const dailyCountCache    = new Map();
const rateWindowCache    = new Map();
const chatLockCache      = new Map();
const postSentCache      = new Set();
const likeCooldownCache  = new Map();
const reactionGroupCache = new Map();

// Chat grouping cache — key: receiverUid_senderUid
const chatGroupCache     = new Map();

// Cache cleanup
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
    for (const [key, ts] of likeCooldownCache) {
        if (now - ts > LIKE_COOLDOWN_MS) likeCooldownCache.delete(key);
    }
    if (postSentCache.size > 1000) postSentCache.clear();

    console.log(`Cache cleanup — Daily:${dailyCountCache.size} Rate:${rateWindowCache.size}`);
}, 5 * 60 * 1000);

setInterval(() => {
    dailyCountCache.clear();
    console.log("Daily count cache reset");
}, 60 * 60 * 1000);

// ─── Health Check ──────────────────────────────────────────────────────────
app.get('/',           (req, res) => res.send("Health Jobs API is Live!"));
app.get('/api/server', (req, res) => res.send("API is Live!"));


// ══════════════════════════════════════════════════════════════════════════
// HELPER: HTML صاف کرو
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
        // Emojis ہٹاؤ
        .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
        .replace(/[\u{2600}-\u{27BF}]/gu,   '')
        .replace(/[\u{FE00}-\u{FE0F}]/gu,   '')
        .replace(/[\u{200D}]/gu,             '')
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
// HELPER: Notification page URL — postId کے ساتھ
// ══════════════════════════════════════════════════════════════════════════
function notifUrl(postId) {
    return postId ? `${NOTIF_PAGE}?highlight=${postId}` : NOTIF_PAGE;
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
// HELPER: Rate window check (post bundling)
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
function acquirePostLock(postId) {
    if (!postId) return false;
    if (postSentCache.has(String(postId))) return false;
    postSentCache.add(String(postId));
    return true;
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: Chat dedup (5s window)
// ══════════════════════════════════════════════════════════════════════════
function acquireChatLock(senderUid, receiverUid) {
    if (!senderUid || !receiverUid) return true;
    const window5s = Math.floor(Date.now() / 5000);
    const key      = `chat_${senderUid}_${receiverUid}_${window5s}`;
    if (chatLockCache.has(key)) return false;
    chatLockCache.set(key, Date.now());
    return true;
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: Invalid tokens Firestore سے remove کرو
// ══════════════════════════════════════════════════════════════════════════
async function removeInvalidTokens(responses, tokens) {
    const batch    = db.batch();
    let removed    = 0;
    const badCodes = [
        'messaging/invalid-registration-token',
        'messaging/registration-token-not-registered'
    ];
    for (let i = 0; i < responses.length; i++) {
        const resp = responses[i];
        if (!resp.success && badCodes.includes(resp.error?.code)) {
            try {
                const snap = await db.collection('users').where('fcmToken', '==', tokens[i]).get();
                snap.forEach(d => {
                    batch.update(d.ref, { fcmToken: admin.firestore.FieldValue.delete() });
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
// HELPER: Single user ka FCM token
// ══════════════════════════════════════════════════════════════════════════
async function getUserToken(uid) {
    if (!uid) return null;
    const d = await db.collection('users').doc(uid).get();
    if (!d.exists) return null;
    const raw = d.data().fcmToken;
    return Array.isArray(raw) ? raw[0] : raw;
}


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 1 — POST NOTIFICATION  (/api/server)
// Click → notifications.html?highlight=postId
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/server', async (req, res) => {
    try {
        const { title, hospital, body, postId, postSlug, senderPhoto, posterId } = req.body;
        console.log("Post Notification:", { postId, posterId });

        if (!postId) return res.status(400).json({ success: false, message: "postId required" });

        // Dedup — ایک post کا صرف ایک notification
        if (!acquirePostLock(postId)) {
            console.log("Duplicate suppressed:", postId);
            return res.status(200).json({ success: false, message: "Already sent" });
        }

        // Click URL — notifications page پر جائے
        const clickUrl      = notifUrl(postId);
        const cleanTitle    = stripHtml(title)    || 'New Post';
        const cleanHospital = stripHtml(hospital) || 'Health Jobs';
        const cleanBody     = stripHtml(body)     || 'Tap to view.';
        const posterIcon    = getIcon(senderPhoto);

        // سب users کے tokens
        const usersSnap = await db.collection('users').get();
        const userMap   = new Map();
        usersSnap.forEach(doc => {
            if (posterId && doc.id === posterId) return;
            const data   = doc.data();
            const raw    = data.fcmToken;
            if (!raw) return;
            const tokens = (Array.isArray(raw) ? raw : [raw]).filter(t => t && t.length > 10);
            if (tokens.length > 0) userMap.set(doc.id, { tokens });
        });

        if (userMap.size === 0) return res.status(200).json({ success: false, message: "No users" });

        const postEntry = { postId, title: cleanTitle, poster: cleanHospital, photo: senderPhoto || LOGO_URL, url: clickUrl };

        let totalSent = 0, totalFailed = 0;
        const allTokens = [], allResponses = [];

        for (const [uid, { tokens }] of userMap) {
            if (!checkDailyLimit(uid)) continue;

            const { shouldBundle, count, posts } = checkRateLimit(uid, postEntry);
            let msg;

            if (shouldBundle) {
                // Bundle notification
                const names      = [...new Set(posts.map(p => p.poster))].slice(0, 2).join(', ');
                const bundleUrl  = NOTIF_PAGE;
                msg = {
                    notification: {
                        title: `${count} New Posts on Health Jobs`,
                        body:  `${names}${count > 2 ? ` and ${count - 2} others` : ''} posted new jobs`
                    },
                    webpush: {
                        notification: {
                            icon:               LOGO_URL,
                            badge:              LOGO_URL,
                            requireInteraction: false,
                            tag:                `bundle_${uid}`,
                            renotify:           true
                        },
                        fcmOptions: { link: bundleUrl },
                        headers:    { Urgency: 'normal' }
                    },
                    android: {
                        priority: 'high',
                        notification: { icon: 'ic_notification', color: '#0a66c2', channel_id: 'high_importance_channel', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
                    },
                    data: { type: 'bundle', count: String(count), clickUrl: bundleUrl },
                    tokens
                };
            } else {
                // Single post notification
                const notifTitle = `${cleanHospital}: ${cleanTitle}`;
                const notifBody  = cleanBody.length > 120 ? cleanBody.substring(0, 120) + '...' : cleanBody;
                msg = {
                    notification: { title: notifTitle, body: notifBody },
                    webpush: {
                        notification: {
                            icon:               posterIcon,
                            badge:              LOGO_URL,
                            requireInteraction: false,
                            tag:                `post_${postId}`,
                            renotify:           false
                        },
                        fcmOptions: { link: clickUrl },
                        headers:    { Urgency: 'normal' }
                    },
                    android: {
                        priority: 'high',
                        notification: { icon: 'ic_notification', color: '#0a66c2', channel_id: 'high_importance_channel', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
                    },
                    data: { type: 'general_post', postId: String(postId), postSlug: String(postSlug || postId), clickUrl },
                    tokens
                };
            }

            const response = await admin.messaging().sendEachForMulticast(msg);
            totalSent   += response.successCount;
            totalFailed += response.failureCount;
            tokens.forEach(t => allTokens.push(t));
            response.responses.forEach(r => allResponses.push(r));
        }

        if (allResponses.some(r => !r.success)) await removeInvalidTokens(allResponses, allTokens);

        return res.status(200).json({ success: true, sent: totalSent, failed: totalFailed });

    } catch (error) {
        console.error("Post Notification Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 2 — CHAT MESSAGE NOTIFICATION  (/api/chat)
//
// Logic:
// - Single message → فوری notification → click سے chat.html?uid=senderUid
// - 3+ messages (60s window) → grouped dropdown notification → chat.html?uid=senderUid
// ══════════════════════════════════════════════════════════════════════════
async function sendChatNotification(receiverUid, token, group) {
    const count      = group.messages.length;
    const senderUid  = group.senderUid;
    const senderName = group.senderName;
    const senderPic  = group.senderPhoto;
    const clickUrl   = `${BASE_URL}/chat.html?uid=${senderUid}`;

    let title, body;

    if (count < CHAT_GROUP_MIN) {
        // Single یا 2 messages — normal notification
        const lastMsg = group.messages[group.messages.length - 1];
        title = senderName;
        body  = lastMsg.length > 80 ? lastMsg.substring(0, 80) + '...' : lastMsg;
    } else {
        // 3+ messages — grouped notification
        title = `${senderName} (${count} messages)`;
        // آخری 2 messages preview دکھاؤ
        const previews = group.messages.slice(-2).map(m => m.length > 40 ? m.substring(0, 40) + '...' : m);
        body  = previews.join(' / ');
    }

    try {
        await admin.messaging().send({
            notification: { title, body },
            webpush: {
                notification: {
                    icon:               getIcon(senderPic),
                    badge:              LOGO_URL,
                    requireInteraction: false,
                    tag:                `chat_${senderUid}`,  // ایک sender کا ایک tag
                    renotify:           true
                },
                fcmOptions: { link: clickUrl },
                headers:    { Urgency: 'high' }
            },
            android: {
                priority: 'high',
                notification: { icon: 'ic_notification', color: '#0a66c2', channel_id: 'high_importance_channel', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
            },
            data: {
                type:      'chat_message',
                senderUid: String(senderUid),
                count:     String(count),
                clickUrl
            },
            token
        });
        console.log(`Chat notification sent: ${count} msg(s) to ${receiverUid}`);
    } catch (e) {
        console.error("Chat send error:", e.message);
    }
}

app.post('/api/chat', async (req, res) => {
    try {
        const { receiverUid, targetToken, senderName, senderUid, senderPhoto, messagePreview } = req.body;
        console.log("Chat:", { senderUid, receiverUid });

        // 5 سیکنڈ کا basic dedup
        if (!acquireChatLock(senderUid, receiverUid)) {
            return res.status(200).json({ success: false, message: "Duplicate suppressed" });
        }

        let token = targetToken;
        if (!token && receiverUid) token = await getUserToken(receiverUid);
        if (!token)     return res.status(400).json({ error: "No FCM token" });
        if (!senderUid) return res.status(400).json({ error: "senderUid required" });

        const limitKey    = receiverUid || token.substring(0, 20);
        if (!checkDailyLimit(`chat_${limitKey}`)) {
            return res.status(200).json({ success: false, message: "Daily limit" });
        }

        const cleanPreview = stripHtml(messagePreview) || '';
        const cleanSender  = stripHtml(senderName)    || 'Healthcare User';

        // ── Chat Grouping Cache ──────────────────────────────────────────
        // key = receiverUid + senderUid مل کر ایک unique key
        const groupKey = `${receiverUid}_${senderUid}`;
        const existing = chatGroupCache.get(groupKey);

        if (existing) {
            // Window active — message add کرو، timer reset کرو
            clearTimeout(existing.timer);
            if (cleanPreview) existing.messages.push(cleanPreview);

            existing.timer = setTimeout(async () => {
                chatGroupCache.delete(groupKey);
                await sendChatNotification(receiverUid, token, existing);
            }, CHAT_GROUP_MS);

            chatGroupCache.set(groupKey, existing);
            return res.status(200).json({ success: true, queued: true, count: existing.messages.length });

        } else {
            // نئی window
            const group = {
                senderUid,
                senderName:  cleanSender,
                senderPhoto: senderPhoto || '',
                messages:    cleanPreview ? [cleanPreview] : [],
                timer: setTimeout(async () => {
                    chatGroupCache.delete(groupKey);
                    await sendChatNotification(receiverUid, token, group);
                }, CHAT_GROUP_MS)
            };
            chatGroupCache.set(groupKey, group);
            return res.status(200).json({ success: true, queued: true, count: 1 });
        }

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

        // Cancel call
        if (action === 'cancel') {
            await admin.messaging().send({
                data: { action: 'cancel_call', callerUid: String(callerUid || '') },
                android: { priority: 'high', ttl: 10000 },
                webpush: { headers: { TTL: '10' } },
                token: targetToken
            });
            return res.status(200).json({ success: true, type: 'cancel' });
        }

        const cleanName    = stripHtml(callerName) || 'Health Jobs User';
        const callText     = callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';
        const clickUrl     = `${BASE_URL}/chat.html?uid=${callerUid}&startCall=true&callType=${callType || 'audio'}&incoming=true`;

        await admin.messaging().send({
            notification: { title: cleanName, body: callText },
            webpush: {
                notification: {
                    icon:               getIcon(callerPhoto),
                    badge:              LOGO_URL,
                    requireInteraction: true,
                    tag:                `call_${callerUid}`,
                    vibrate:            [200, 100, 200, 100, 200]
                },
                fcmOptions: { link: clickUrl },
                headers:    { TTL: '30', Urgency: 'high' }
            },
            android: {
                priority: 'high',
                ttl:      30000,
                notification: { icon: 'ic_notification', color: '#0a66c2', channel_id: 'high_importance_channel', click_action: 'FLUTTER_NOTIFICATION_CLICK', tag: `call_${callerUid}` }
            },
            data: { isCall: 'true', callerUid: String(callerUid || ''), callerName: cleanName, callType: String(callType || 'audio'), clickUrl },
            token: targetToken
        });

        return res.status(200).json({ success: true, type: 'call' });

    } catch (error) {
        console.error("Call Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 4 — LIKE / COMMENT NOTIFICATION  (/api/reaction)
//
// Logic:
// - 30s window میں 3+ reactions آئیں → grouped dropdown notification
// - Click → notifications.html?highlight=postId
// ══════════════════════════════════════════════════════════════════════════
async function sendReactionNotification(postOwnerId, token, group, clickUrl) {
    const count  = group.posts.length;
    const actors = [...new Set(group.posts.map(p => p.actor))];
    const types  = [...new Set(group.posts.map(p => p.type))];

    let title, body;

    if (count < 3) {
        // Single یا 2 — normal
        const p = group.posts[count - 1];
        if (p.type === 'like') {
            title = `${p.actor} liked your post`;
            body  = p.postTitle ? `"${p.postTitle}"` : 'Tap to view';
        } else {
            title = `${p.actor} commented on your post`;
            body  = p.comment
                ? (p.comment.length > 80 ? p.comment.substring(0, 80) + '...' : p.comment)
                : 'Tap to view';
        }
    } else {
        // 3+ reactions — grouped
        const actorList  = actors.slice(0, 2).join(', ') + (actors.length > 2 ? ` and ${actors.length - 2} others` : '');
        const hasLike    = types.includes('like');
        const hasComment = types.includes('comment');

        if (hasLike && hasComment) {
            title = `${count} interactions on your post`;
            body  = `${actorList} liked and commented`;
        } else if (hasLike) {
            title = `${count} people liked your post`;
            body  = actorList;
        } else {
            title = `${count} comments on your post`;
            body  = actorList;
        }
    }

    try {
        await admin.messaging().send({
            notification: { title, body },
            webpush: {
                notification: {
                    icon:               getIcon(group.posts[0].actorPhoto),
                    badge:              LOGO_URL,
                    requireInteraction: false,
                    tag:                `reaction_${postOwnerId}`,
                    renotify:           true
                },
                fcmOptions: { link: clickUrl },
                headers:    { Urgency: 'normal' }
            },
            android: {
                priority: 'normal',
                notification: { icon: 'ic_notification', color: '#e91e63', channel_id: 'high_importance_channel', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
            },
            data: { type: 'reaction_group', count: String(count), clickUrl },
            token
        });
        console.log(`Reaction sent: ${count} item(s) to ${postOwnerId}`);
    } catch (e) {
        console.error("Reaction send error:", e.message);
    }
}

app.post('/api/reaction', async (req, res) => {
    try {
        const { type, postId, postSlug, postTitle, postOwnerId, actorName, actorUid, actorPhoto, commentPreview } = req.body;
        console.log("Reaction:", { type, postOwnerId, actorUid });

        if (!postOwnerId)                              return res.status(400).json({ error: "postOwnerId required" });
        if (!type || !['like','comment'].includes(type)) return res.status(400).json({ error: "type must be like/comment" });
        if (actorUid && actorUid === postOwnerId)      return res.status(200).json({ success: false, message: "Self-reaction" });

        // Like cooldown — 6 گھنٹے
        if (type === 'like' && actorUid && postId) {
            const coolKey  = `like_${actorUid}_${postId}`;
            const lastSent = likeCooldownCache.get(coolKey);
            if (lastSent && (Date.now() - lastSent) < LIKE_COOLDOWN_MS) {
                return res.status(200).json({ success: false, message: "Like cooldown" });
            }
            likeCooldownCache.set(coolKey, Date.now());
        }

        if (!checkDailyLimit(`reaction_${postOwnerId}`)) {
            return res.status(200).json({ success: false, message: "Daily limit" });
        }

        const token = await getUserToken(postOwnerId);
        if (!token) return res.status(200).json({ success: false, message: "No token" });

        // Click → notifications.html?highlight=postId
        const clickUrl   = notifUrl(postId);
        const cleanActor = stripHtml(actorName) || 'Someone';
        const cleanTitle = stripHtml(postTitle) || '';
        const cleanCmnt  = stripHtml(commentPreview) || '';

        const reactionEntry = {
            type,
            actor:      cleanActor,
            actorPhoto: actorPhoto || '',
            postTitle:  cleanTitle,
            comment:    cleanCmnt,
            postId:     postId || '',
            postSlug:   postSlug || ''
        };

        // ── Reaction grouping (30s window) ───────────────────────────────
        const existing = reactionGroupCache.get(postOwnerId);

        if (existing) {
            clearTimeout(existing.timer);
            existing.posts.push(reactionEntry);
            existing.timer = setTimeout(async () => {
                reactionGroupCache.delete(postOwnerId);
                await sendReactionNotification(postOwnerId, token, existing, clickUrl);
            }, REACTION_GROUP_MS);
            reactionGroupCache.set(postOwnerId, existing);
            return res.status(200).json({ success: true, queued: true, count: existing.posts.length });

        } else {
            const group = {
                posts: [reactionEntry],
                timer: setTimeout(async () => {
                    reactionGroupCache.delete(postOwnerId);
                    await sendReactionNotification(postOwnerId, token, group, clickUrl);
                }, REACTION_GROUP_MS)
            };
            reactionGroupCache.set(postOwnerId, group);
            return res.status(200).json({ success: true, queued: true, count: 1 });
        }

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
        const cleanName  = stripHtml(callerName) || 'Health Jobs User';
        const clickUrl   = `${BASE_URL}/chat.html?uid=${callerUid}&startCall=true&callType=${callType || 'audio'}&incoming=true`;
        const callText   = callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';

        await admin.messaging().send({
            notification: { title: cleanName, body: callText },
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
                notification: { icon: 'ic_notification', color: '#0a66c2', channel_id: 'high_importance_channel', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
            },
            data: { isCall: 'true', callerUid: String(callerUid || ''), callerName: cleanName, callType: String(callType || 'audio'), clickUrl },
            token: targetToken
        });

        return res.status(200).json({ success: true, type: 'call' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});


export default app;
