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
async function writeInAppNotification(docData) {
    try {
        await db.collection('notifications').add({
            ...docData,
            createdAt: Date.now(),
            read: false
        });
    } catch (e) {
        console.error('In-app notification write failed:', e.message);
    }
}

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
//
// ⚠️ FIX: top-level `notification` field ہٹا دیا گیا ہے۔ اب title/body/icon
// صرف `data` میں جاتے ہیں تاکہ SW کا onBackgroundMessage ہمیشہ چلے اور
// notificationclick میں صحیح clickUrl ملے (Firebase کا auto-display کبھی
// درمیان میں نہ آئے)۔
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
                const bundleTitle = `${count} New Posts on Health Jobs`;
                const bundleBody  = `${names}${count > 2 ? ` and ${count - 2} others` : ''} posted new jobs`;

                msg = {
                    webpush: {
                        headers: { Urgency: 'normal' }
                    },
                    android: {
                        priority: 'high'
                    },
                    data: {
                        type:     'bundle',
                        title:    bundleTitle,
                        body:     bundleBody,
                        icon:     LOGO_URL,
                        tag:      `bundle_${uid}`,
                        count:    String(count),
                        clickUrl: bundleUrl
                    },
                    tokens
                };
            } else {
                // Single post notification
                const notifTitle = `${cleanHospital}: ${cleanTitle}`;
                const notifBody  = cleanBody.length > 120 ? cleanBody.substring(0, 120) + '...' : cleanBody;

                msg = {
                    webpush: {
                        headers: { Urgency: 'normal' }
                    },
                    android: {
                        priority: 'high'
                    },
                    data: {
                        type:     'general_post',
                        title:    notifTitle,
                        body:     notifBody,
                        icon:     posterIcon,
                        tag:      `post_${postId}`,
                        postId:   String(postId),
                        postSlug: String(postSlug || postId),
                        clickUrl
                    },
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
            webpush: {
                headers: { Urgency: 'high' }
            },
            android: {
                priority: 'high'
            },
            data: {
                type:      'chat_message',
                title,
                body,
                icon:      getIcon(senderPic),
                tag:       `chat_${senderUid}`,
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
// ROUTE 3 — CALL NOTIFICATION + CALL LOG  (/api/call  aur legacy /api)
//
// Actions (body.action):
//   (none)     → call ring:  FCM push + notifications.html mein "ringing" entry
//   'cancel'   → caller ne ring khatam ki (ya 45s timeout) → callee ko "Missed call"
//   'decline'  → callee ne reject kiya   → dono ke liye "declined" entry
//   'answered' → call connect hui / khatam hui (duration ke sath) → dono ke liye
//
// Har call ki ek `callId` hoti hai (chat.html banata hai). Notification doc ka
// ID deterministic hai (call_<callId>_<uid>) is liye ek call = ek entry, aur
// status badalne par wahi entry update hoti hai (duplicate nahi banti).
// ══════════════════════════════════════════════════════════════════════════
function cleanCallId(id) {
    return String(id || '').replace(/[^A-Za-z0-9_-]/g, '').substring(0, 120);
}

function fmtDuration(sec) {
    sec = Math.max(0, parseInt(sec, 10) || 0);
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function getUserBasic(uid) {
    const fallback = { name: 'Health Jobs User', photo: '' };
    if (!uid) return fallback;
    try {
        const d = await db.collection('users').doc(String(uid)).get();
        if (!d.exists) return fallback;
        const u = d.data() || {};
        return {
            name:  stripHtml(u.facilityName || u.fullName) || fallback.name,
            photo: u.profilePicUrl || ''
        };
    } catch (_) { return fallback; }
}

function callMessage(role, status, callType, duration) {
    const kind = callType === 'video' ? 'video call' : 'audio call';
    if (role === 'incoming') {
        if (status === 'ringing')  return `Incoming ${kind}`;
        if (status === 'missed')   return `Missed ${kind}`;
        if (status === 'declined') return `You declined the ${kind}`;
        return duration ? `${kind} · ${fmtDuration(duration)}` : kind;
    }
    if (status === 'no_answer') return 'No answer';
    if (status === 'declined')  return `${kind} declined`;
    return duration ? `${kind} · ${fmtDuration(duration)}` : kind;
}

async function writeCallLog({ callId, ownerUid, otherUid, otherName, otherPhoto, role, status, callType, duration = 0, unread = false }) {
    if (!callId || !ownerUid) return;
    try {
        await db.collection('notifications').doc(`call_${callId}_${ownerUid}`).set({
            type:         'call',
            callId,
            callStatus:   status,
            callRole:     role,
            callType:     callType === 'video' ? 'video' : 'audio',
            callDuration: parseInt(duration, 10) || 0,
            toUid:        String(ownerUid),
            fromUid:      String(otherUid || ''),
            actorUid:     String(otherUid || ''),
            fromName:     otherName,
            actorName:    otherName,
            fromPic:      getIcon(otherPhoto),
            message:      callMessage(role, status, callType, duration),
            link:         `/chat.html?uid=${otherUid}`,
            postId:       '',
            postSlug:     '',
            createdAt:    Date.now(),
            read:         !unread
        }, { merge: true });
    } catch (e) {
        console.error('Call log write failed:', e.message);
    }
}

// Call ka final outcome dono users ke notifications mein likho
async function logCallOutcome({ callId, callerUid, calleeUid, callType, outcome, duration }) {
    const [caller, callee] = await Promise.all([getUserBasic(callerUid), getUserBasic(calleeUid)]);
    // callee ki entry: (other = caller)   |   caller ki entry: (other = callee)
    const map = {
        missed:   { callee: 'missed',   caller: 'no_answer', calleeUnread: true,  callerUnread: false },
        declined: { callee: 'declined', caller: 'declined',  calleeUnread: false, callerUnread: true  },
        answered: { callee: 'answered', caller: 'answered',  calleeUnread: false, callerUnread: false }
    }[outcome];
    if (!map) return;

    await Promise.all([
        writeCallLog({ callId, ownerUid: calleeUid, otherUid: callerUid, otherName: caller.name, otherPhoto: caller.photo,
                       role: 'incoming', status: map.callee, callType, duration, unread: map.calleeUnread }),
        writeCallLog({ callId, ownerUid: callerUid, otherUid: calleeUid, otherName: callee.name, otherPhoto: callee.photo,
                       role: 'outgoing', status: map.caller, callType, duration, unread: map.callerUnread })
    ]);
}

async function handleCallRequest(req, res) {
    try {
        const { targetToken, callerName, callerUid, callerPhoto, callType, action, callId, calleeUid, duration } = req.body || {};
        const type = callType === 'video' ? 'video' : 'audio';
        const cid  = cleanCallId(callId);
        console.log("Call:", { callerUid, calleeUid, action, callId: cid });

        // ── Decline / Answered — sirf log, push ki zaroorat nahi ──────────
        if (action === 'decline' || action === 'answered') {
            if (!cid || !callerUid || !calleeUid) return res.status(400).json({ error: "callId, callerUid, calleeUid required" });
            await logCallOutcome({ callId: cid, callerUid, calleeUid, callType: type, outcome: action, duration });
            return res.status(200).json({ success: true, type: action });
        }

        if (!targetToken) return res.status(400).json({ error: "targetToken required" });

        const cleanName = stripHtml(callerName) || 'Health Jobs User';

        // ── Cancel (caller ne kaat di / koi jawab nahi) → Missed call ─────
        if (action === 'cancel') {
            await admin.messaging().send({
                data: { action: 'cancel_call', callerUid: String(callerUid || '') },
                android: { priority: 'high', ttl: 10000 },
                webpush: { headers: { TTL: '10' } },
                token: targetToken
            });

            if (cid && callerUid && calleeUid) {
                await logCallOutcome({ callId: cid, callerUid, calleeUid, callType: type, outcome: 'missed' });
            }

            // Missed-call push — click par notifications page khule
            try {
                await admin.messaging().send({
                    webpush: { headers: { Urgency: 'high' } },
                    android: { priority: 'high' },
                    data: {
                        type:      'call_missed',
                        title:     cleanName,
                        body:      `Missed ${type} call`,
                        icon:      getIcon(callerPhoto),
                        tag:       `missed_${callerUid}`,
                        callerUid: String(callerUid || ''),
                        clickUrl:  NOTIF_PAGE
                    },
                    token: targetToken
                });
            } catch (e) { console.error("Missed-call push error:", e.message); }

            return res.status(200).json({ success: true, type: 'cancel' });
        }

        // ── Ring (nayi call) ──────────────────────────────────────────────
        const callText = type === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';
        // Click → seedha chat.html ki call screen
        const clickUrl = `${BASE_URL}/chat.html?uid=${callerUid}&startCall=true&callType=${type}&incoming=true`;

        const tasks = [
            admin.messaging().send({
                webpush: { headers: { TTL: '30', Urgency: 'high' } },
                android: { priority: 'high', ttl: 30000 },
                data: {
                    isCall:     'true',
                    type:       'call',
                    title:      cleanName,
                    body:       callText,
                    icon:       getIcon(callerPhoto),
                    tag:        `call_${callerUid}`,
                    callerUid:  String(callerUid || ''),
                    callerName: cleanName,
                    callType:   type,
                    callId:     cid,
                    clickUrl
                },
                token: targetToken
            })
        ];

        // notifications.html mein "Incoming call" entry
        if (cid && callerUid && calleeUid) {
            tasks.push(writeCallLog({
                callId: cid, ownerUid: calleeUid, otherUid: callerUid,
                otherName: cleanName, otherPhoto: callerPhoto,
                role: 'incoming', status: 'ringing', callType: type, unread: true
            }));
        }

        const results = await Promise.allSettled(tasks);
        if (results[0].status === 'rejected') throw results[0].reason;

        return res.status(200).json({ success: true, type: 'call' });

    } catch (error) {
        console.error("Call Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
}

app.post('/api/call', handleCallRequest);


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
            webpush: {
                headers: { Urgency: 'normal' }
            },
            android: {
                priority: 'normal'
            },
            data: {
                type:     'reaction_group',
                title,
                body,
                icon:     getIcon(group.posts[0].actorPhoto),
                tag:      `reaction_${postOwnerId}`,
                count:    String(count),
                clickUrl
            },
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
// ROUTE 5 — /api (legacy call route) — ab wahi handler
// ══════════════════════════════════════════════════════════════════════════
app.post('/api', handleCallRequest);


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 7 — ADMIN PUSH  (/api/admin-push)
//
// Admin Worker (compose.html wala) sirf Firestore mein in-app entries likhta tha,
// FCM push kabhi nahi jati thi. Yeh route sirf PUSH bhejta hai (in-app entry
// Worker khud likh chuka hota hai — is liye yahan dobara nahi likhte, warna
// duplicate banti).
//
// Auth: header `x-push-admin-secret` == process.env.PUSH_ADMIN_SECRET
//       (yeh secret sirf Worker aur Vercel env mein hai, kisi page mein nahi).
// Body: { uids: [..max 1000], title, body, link? }
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/admin-push', async (req, res) => {
    try {
        const secret = process.env.PUSH_ADMIN_SECRET;
        if (!secret) return res.status(500).json({ error: 'PUSH_ADMIN_SECRET not configured on server' });
        if (req.get('x-push-admin-secret') !== secret) return res.status(401).json({ error: 'Unauthorized' });

        const { uids, title, body, link } = req.body || {};
        if (!Array.isArray(uids) || !uids.length) return res.status(400).json({ error: 'uids required' });
        if (uids.length > 1000)                   return res.status(400).json({ error: 'max 1000 uids per request' });
        if (!title || !String(title).trim())      return res.status(400).json({ error: 'title required' });

        const cleanTitle = stripHtml(title) || 'Health Jobs Portal';
        const cleanBody  = stripHtml(body).substring(0, 180);
        // Sirf https:// ya /relative link; warna notifications page
        const clickUrl   = /^(https?:\/\/|\/)/i.test(String(link || '')) ? String(link) : NOTIF_PAGE;

        // ── Users ke tokens (300 ke chunks mein getAll) ──
        const refs = [...new Set(uids.map(String))]
            .filter(u => u && !u.includes('/'))
            .map(u => db.collection('users').doc(u));

        const tokens = [];
        let noToken = 0;
        for (let i = 0; i < refs.length; i += 300) {
            const snaps = await db.getAll(...refs.slice(i, i + 300));
            snaps.forEach(snap => {
                if (!snap.exists) { noToken++; return; }
                const raw  = snap.data().fcmToken;
                const list = (Array.isArray(raw) ? raw : [raw]).filter(t => t && String(t).length > 10);
                if (!list.length) noToken++;
                else list.forEach(t => tokens.push(t));
            });
        }
        const unique = [...new Set(tokens)];
        if (!unique.length) return res.status(200).json({ success: true, sent: 0, failed: 0, noToken });

        const tag = `admin_${Date.now()}`;
        let sent = 0, failed = 0;
        const allTokens = [], allResponses = [];

        for (let i = 0; i < unique.length; i += 500) {
            const chunk = unique.slice(i, i + 500);
            const r = await admin.messaging().sendEachForMulticast({
                webpush: { headers: { Urgency: 'high' } },
                android: { priority: 'high' },
                data: {
                    type:     'admin_announcement',
                    title:    cleanTitle,
                    body:     cleanBody,
                    icon:     LOGO_URL,
                    tag,
                    clickUrl
                },
                tokens: chunk
            });
            sent   += r.successCount;
            failed += r.failureCount;
            chunk.forEach(t => allTokens.push(t));
            r.responses.forEach(x => allResponses.push(x));
        }

        if (allResponses.some(r => !r.success)) await removeInvalidTokens(allResponses, allTokens);

        return res.status(200).json({ success: true, sent, failed, noToken });

    } catch (error) {
        console.error('Admin Push Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
});


// ══════════════════════════════════════════════════
// ROUTE 6 — PORTAL EVENT NOTIFICATION  (/api/portal)
//
// Yeh route admin approval panel aur ad manager use karte hain: jab bhi
// kisi user ke account ya ad order par koi faisla hota hai, usay us ke
// notifications page par ek saaf, professional update milti hai.
//
// Ek hi call se do cheezein hoti hain:
//   1. Firestore notification doc  → notifications.html ki realtime list
//                                    (type 'admin_announcement' = "Portal Updates")
//   2. FCM web push                → browser band ho to bhi pahunch jaye
//
// Email yahan se NAHI jati — woh har worker khud bhejta hai, kyunke asli
// content/context usi ke paas hota hai (aur email opt-out ka hisaab bhi).
//
// Body: { toUid?, toEmail?, type?, title, body, link?, icon?, tag? }
//   toUid   : user ka Firebase uid (best — push ke liye lazmi)
//   toEmail : uid na ho to email se user dhundh liya jata hai
//   type    : default 'admin_announcement' (notifications.html isay
//             "Portal Updates" group mein dikhata hai)
// ══════════════════════════════════════════════════
app.post('/api/portal', async (req, res) => {
    try {
        const {
            toUid, toEmail,
            type = 'admin_announcement',
            title, body,
            link = '',
            icon = LOGO_URL,
            tag  = '',
            fromName = 'Health Jobs Team'
        } = req.body || {};

        if (!toUid && !toEmail) return res.status(400).json({ success: false, message: 'toUid or toEmail required' });
        if (!title || !String(title).trim()) return res.status(400).json({ success: false, message: 'title required' });

        // ── Recipient dhundo ──────────────────────────────────────
        let uid = String(toUid || '').trim();
        if (!uid && toEmail) {
            const q = await db.collection('users').where('email', '==', String(toEmail).toLowerCase()).limit(1).get();
            if (!q.empty) uid = q.docs[0].id;
        }
        if (!uid) return res.status(200).json({ success: false, message: 'User not found' });

        const cleanTitle = stripHtml(title) || 'Health Jobs Portal';
        const cleanBody  = stripHtml(body)  || '';

        // ── 1) In-app notification (notifications.html realtime list) ──
        await writeInAppNotification({
            type:      String(type),
            toUid:     uid,
            fromUid:   'admin',
            actorUid:  'admin',
            fromName:  String(fromName),
            actorName: String(fromName),
            fromPic:   getIcon(icon),
            message:   cleanBody.substring(0, 300),
            title:     cleanTitle,
            link:      link || '',
            postId:    '',
            postSlug:  ''
        });

        // ── 2) FCM web push ────────────────────────────────────────
        // Data-only payload — SW ka onBackgroundMessage khud show karta hai
        // aur clickUrl set karta hai. Top-level `notification` block na
        // hone se Firebase ka auto-display beech mein nahi aata.
        const token = await getUserToken(uid);
        if (!token) return res.status(200).json({ success: true, inApp: true, push: false, message: 'No device token' });

        const response = await admin.messaging().sendEachForMulticast({
            webpush: { headers: { Urgency: 'high' } },
            android: { priority: 'high' },
            data: {
                type:     String(type),
                title:    cleanTitle,
                body:     cleanBody.substring(0, 180),
                icon:     getIcon(icon),
                tag:      String(tag || `${type}_${uid}`),
                clickUrl: link || NOTIF_PAGE
            },
            tokens: [token]
        });

        if (response.responses && response.responses.some(r => !r.success)) {
            await removeInvalidTokens(response.responses, [token]);
        }

        return res.status(200).json({
            success: true,
            inApp:   true,
            push:    response.successCount > 0,
            sent:    response.successCount,
            failed:  response.failureCount
        });

    } catch (error) {
        console.error('Portal Notification Error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});


export default app;
