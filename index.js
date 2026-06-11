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

// ─── Health Check ──────────────────────────────────────────────────────────
app.get('/',           (req, res) => res.send("✅ Health Jobs API is Live!"));
app.get('/api/server', (req, res) => res.send("✅ API is Live!"));


// ══════════════════════════════════════════════════════════════════════════
// HELPER: HTML tags اور entities صاف کرو - plain text بناؤ
// ✅ FIX: notification body میں &nbsp;<p>...</p> آنے کا مسئلہ حل
// ══════════════════════════════════════════════════════════════════════════
function stripHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/<[^>]*>/g, '')         // HTML tags ہٹاؤ
        .replace(/&nbsp;/g, ' ')         // &nbsp; → space
        .replace(/&amp;/g, '&')          // &amp; → &
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')            // multiple spaces → single
        .trim();
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: valid icon URL یا logo fallback
// ══════════════════════════════════════════════════════════════════════════
function getIcon(photo) {
    return photo && photo.startsWith('http') ? photo : LOGO_URL;
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: per-user daily count چیک کرو اور بڑھاؤ
// ══════════════════════════════════════════════════════════════════════════
async function checkAndIncrementDailyCount(uid) {
    const today = new Date().toISOString().split('T')[0];
    const ref   = db.collection('notif_daily_counts').doc(`${uid}_${today}`);
    try {
        const result = await db.runTransaction(async (tx) => {
            const snap  = await tx.get(ref);
            const count = snap.exists ? (snap.data().count || 0) : 0;
            if (count >= DAILY_MAX) return false;
            tx.set(ref, { count: count + 1, uid, date: today }, { merge: true });
            return true;
        });
        return result;
    } catch (e) {
        console.error("❌ Daily count error:", e.message);
        return true;
    }
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: post notification deduplication
// ✅ FIX: ایک postId کا notification صرف ایک بار جائے
// ══════════════════════════════════════════════════════════════════════════
async function acquirePostLock(postId) {
    const ref = db.collection('notif_sent_posts').doc(String(postId));
    try {
        const result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (snap.exists) return false;
            tx.set(ref, { sentAt: Date.now() });
            return true;
        });
        return result;
    } catch (e) {
        console.error("❌ Post lock error:", e.message);
        return false;
    }
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: chat notification deduplication
// ✅ FIX: ایک ہی chat message کا notification بار بار نہ جائے
// ──────────────────────────────────────────────────────────────────────────
// chatId = `${senderUid}_${receiverUid}_${timestamp_rounded_to_5s}`
// ══════════════════════════════════════════════════════════════════════════
async function acquireChatLock(senderUid, receiverUid) {
    const window5s = Math.floor(Date.now() / 5000);  // 5 سیکنڈ کی window
    const lockKey  = `chat_${senderUid}_${receiverUid}_${window5s}`;
    const ref      = db.collection('notif_chat_locks').doc(lockKey);
    try {
        const result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (snap.exists) return false;  // پہلے 5 سیکنڈ میں بھیج چکے
            tx.set(ref, { sentAt: Date.now() });
            return true;
        });
        return result;
    } catch (e) {
        console.error("❌ Chat lock error:", e.message);
        return true;
    }
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: rate window چیک کرو
// ══════════════════════════════════════════════════════════════════════════
async function checkRateWindow(uid, postEntry) {
    const ref    = db.collection('notif_rate_windows').doc(uid);
    const nowMs  = Date.now();
    const cutoff = nowMs - RATE_WINDOW_MS;
    try {
        const result = await db.runTransaction(async (tx) => {
            const snap   = await tx.get(ref);
            let entries  = snap.exists ? (snap.data().entries || []) : [];
            entries      = entries.filter(e => e.ts > cutoff);
            entries.push({ ts: nowMs, ...postEntry });
            tx.set(ref, { entries }, { merge: false });
            if (entries.length > RATE_LIMIT) {
                return { shouldBundle: true, count: entries.length, posts: entries };
            }
            return { shouldBundle: false };
        });
        return result;
    } catch (e) {
        console.error("❌ Rate window error:", e.message);
        return { shouldBundle: false };
    }
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: invalid tokens Firestore سے ہٹاؤ
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
        console.log(`🗑️ Removed ${removed} invalid token(s)`);
    }
}

// ══════════════════════════════════════════════════════════════════════════
// HELPER: تمام users کے tokens اکٹھے کرو
// ══════════════════════════════════════════════════════════════════════════
async function collectUserTokens(excludeUid = null) {
    const usersSnap = await db.collection('users').get();
    const userMap   = new Map();
    usersSnap.forEach(doc => {
        if (excludeUid && doc.id === excludeUid) return;
        const data   = doc.data();
        const raw    = data.fcmToken;
        if (!raw) return;
        const tokens = (Array.isArray(raw) ? raw : [raw]).filter(t => t && t.length > 10);
        if (tokens.length === 0) return;
        userMap.set(doc.id, { tokens });
    });
    return userMap;
}


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 1 — POST NOTIFICATION  (/api/server)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/server', async (req, res) => {
    try {
        const { title, hospital, body, postId, postSlug, senderPhoto, posterId } = req.body;
        console.log("📢 Post Notification:", { title, hospital, postId, postSlug, posterId });

        if (!postId) return res.status(400).json({ success: false, message: "postId is required" });

        // ✅ FIX: ایک postId کا notification صرف ایک بار
        const locked = await acquirePostLock(postId);
        if (!locked) {
            console.log("⚠️ Duplicate suppressed for postId:", postId);
            return res.status(200).json({ success: false, message: "Notification already sent for this post" });
        }

        const postPath = postSlug ? `post/${postSlug}` : `details.html?id=${postId}`;
        const clickUrl = `${BASE_URL}/${postPath}`;

        // ✅ FIX: HTML strip کرو
        const cleanTitle    = stripHtml(title)    || 'New Post';
        const cleanHospital = stripHtml(hospital) || 'Health Jobs';
        const cleanBody     = stripHtml(body)     || 'Tap to view the latest healthcare update.';

        const userMap = await collectUserTokens(posterId);
        console.log("👥 Users to notify:", userMap.size);

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
            const dailyOk = await checkAndIncrementDailyCount(uid);
            if (!dailyOk) { console.log(`⛔ Daily limit uid: ${uid}`); continue; }

            const { shouldBundle, count, posts } = await checkRateWindow(uid, postEntry);
            let msg;

            if (shouldBundle) {
                const names      = [...new Set(posts.map(p => p.poster))].slice(0, 3).join(', ');
                const bundleBody = `${count} new posts from ${names}${count > 3 ? ' & others' : ''}`;
                msg = {
                    notification: { title: `📋 ${count} New Posts on Health Jobs`, body: bundleBody },
                    webpush: {
                        notification: {
                            icon: LOGO_URL, badge: LOGO_URL,
                            requireInteraction: false,
                            tag: `bundle_${uid}`, renotify: true
                        },
                        // ✅ FIX: clickUrl webpush میں بھی ضرور دو
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
                const notifBody  = cleanBody.length > 120 ? cleanBody.substring(0, 120) + '…' : cleanBody;
                msg = {
                    notification: { title: notifTitle, body: notifBody },
                    webpush: {
                        notification: {
                            icon: getIcon(senderPhoto), badge: LOGO_URL,
                            requireInteraction: false,
                            tag: `post_${postId}`
                        },
                        // ✅ FIX: clickUrl ضرور لگاؤ تاکہ notification clickable ہو
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
            console.log(`✅ uid:${uid} — Sent:${response.successCount} ❌ Failed:${response.failureCount}`);
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
        console.error("❌ Post Notification Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 2 — CHAT MESSAGE NOTIFICATION  (/api/chat)
// ✅ FIX: ڈپلیکیٹ notifications روکو + HTML strip + clickable URL
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
    try {
        const { receiverUid, targetToken, senderName, senderUid, senderPhoto, messagePreview } = req.body;
        console.log("💬 Chat Notification:", { senderName, senderUid, receiverUid });

        // ✅ FIX: 5 سیکنڈ کے اندر دوبارہ notification نہ جائے
        if (senderUid && receiverUid) {
            const chatLockOk = await acquireChatLock(senderUid, receiverUid);
            if (!chatLockOk) {
                console.log("⚠️ Chat notification duplicate suppressed");
                return res.status(200).json({ success: false, message: "Duplicate chat notification suppressed" });
            }
        }

        let token = targetToken;
        if (!token && receiverUid) {
            const userDoc = await db.collection('users').doc(receiverUid).get();
            if (userDoc.exists) {
                const rawToken = userDoc.data().fcmToken;
                token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
            }
        }

        if (!token)     return res.status(400).json({ error: "No FCM token found for receiver" });
        if (!senderUid) return res.status(400).json({ error: "senderUid is required" });

        const limitKey = receiverUid || token.substring(0, 20);
        const dailyOk  = await checkAndIncrementDailyCount(`chat_${limitKey}`);
        if (!dailyOk) return res.status(200).json({ success: false, message: "Daily limit reached" });

        // ✅ FIX: HTML strip کرو - notification body صاف ہو
        const cleanPreview = stripHtml(messagePreview);
        const notifBody    = cleanPreview
            ? (cleanPreview.length > 80 ? cleanPreview.substring(0, 80) + '…' : cleanPreview)
            : 'You have a new message. Tap to reply.';

        // ✅ FIX: clickUrl - notification click کرنے پر chat کھلے
        const clickUrl = `${BASE_URL}/chat.html?uid=${senderUid}`;

        const message = {
            notification: {
                title: `💬 ${stripHtml(senderName) || 'Healthcare User'}`,
                body:  notifBody
            },
            webpush: {
                notification: {
                    icon: getIcon(senderPhoto), badge: LOGO_URL,
                    requireInteraction: false,
                    tag: `chat_${senderUid}`,   // same sender → replace (ڈپلیکیٹ نہیں)
                    renotify: true
                },
                // ✅ FIX: یہ link ضرور ہونا چاہیے - notification clickable بنتی ہے
                fcmOptions: { link: clickUrl }
            },
            android: {
                priority: 'high',
                notification: {
                    icon: 'ic_notification', color: '#0a66c2',
                    channel_id: 'high_importance_channel',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                }
            },
            data: {
                type:      'chat_message',
                senderUid: String(senderUid),
                clickUrl
            },
            token
        };

        const r = await admin.messaging().send(message);
        console.log("✅ Chat notification sent:", r);
        return res.status(200).json({ success: true, type: 'chat' });

    } catch (error) {
        console.error("❌ Chat Notification Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 3 — CALL NOTIFICATION  (/api/call)
// ✅ FIX: callerPhoto اور callerName ٹھیک سے pass ہو
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/call', async (req, res) => {
    try {
        const { targetToken, callerName, callerUid, callerPhoto, callType, action } = req.body;
        console.log("📞 Call request:", { callerName, callerUid, callType, action });

        if (!targetToken) return res.status(400).json({ error: "targetToken is required" });

        // ─── Cancel call ───
        if (action === 'cancel') {
            const msg = {
                data: { action: 'cancel_call', callerUid: String(callerUid || '') },
                android: { priority: 'high', ttl: '10s' },
                token: targetToken
            };
            const r = await admin.messaging().send(msg);
            console.log("✅ Cancel sent:", r);
            return res.status(200).json({ success: true, type: 'cancel' });
        }

        // ─── Incoming call ───
        const clickUrl  = `${BASE_URL}/chat.html?uid=${callerUid}&startCall=true&callType=${callType || 'audio'}&incoming=true`;
        const callEmoji = callType === 'video' ? '🎥' : '📞';
        const callText  = callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';

        // ✅ FIX: callerName clean کرو
        const cleanCallerName = stripHtml(callerName) || 'Health Jobs User';

        const msg = {
            notification: {
                title: `${callEmoji} ${cleanCallerName}`,
                body:  callText
            },
            webpush: {
                notification: {
                    icon: getIcon(callerPhoto), badge: LOGO_URL,
                    requireInteraction: true,
                    tag: `call_${callerUid}`
                },
                // ✅ FIX: click کرنے پر chat کھلے
                fcmOptions: { link: clickUrl }
            },
            android: {
                priority: 'high',
                ttl: '30s',
                notification: {
                    icon: 'ic_notification', color: '#0a66c2',
                    channel_id: 'high_importance_channel',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                }
            },
            data: {
                isCall:     'true',
                callerUid:  String(callerUid   || ''),
                callerName: cleanCallerName,
                callType:   String(callType    || 'audio'),
                clickUrl
            },
            token: targetToken
        };

        const r = await admin.messaging().send(msg);
        console.log("✅ Call notification sent:", r);
        return res.status(200).json({ success: true, type: 'call' });

    } catch (error) {
        console.error("❌ Call Notification Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 4 — LIKE / COMMENT NOTIFICATION  (/api/reaction)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/reaction', async (req, res) => {
    try {
        const {
            type, postId, postSlug, postTitle,
            postOwnerId, actorName, actorUid, actorPhoto, commentPreview
        } = req.body;

        console.log("❤️ Reaction Notification:", { type, postId, postOwnerId, actorName });

        if (!postOwnerId) return res.status(400).json({ error: "postOwnerId is required" });
        if (!type || !['like', 'comment'].includes(type)) return res.status(400).json({ error: "type must be 'like' or 'comment'" });
        if (actorUid && actorUid === postOwnerId) return res.status(200).json({ success: false, message: "Self-reaction suppressed" });

        const dailyOk = await checkAndIncrementDailyCount(`reaction_${postOwnerId}`);
        if (!dailyOk) return res.status(200).json({ success: false, message: "Daily limit reached" });

        const ownerDoc = await db.collection('users').doc(postOwnerId).get();
        if (!ownerDoc.exists) return res.status(404).json({ error: "Post owner not found" });

        const rawToken = ownerDoc.data().fcmToken;
        const token    = Array.isArray(rawToken) ? rawToken[0] : rawToken;
        if (!token)    return res.status(200).json({ success: false, message: "Owner has no FCM token" });

        const postPath = postSlug ? `post/${postSlug}` : `details.html?id=${postId}`;
        const clickUrl = `${BASE_URL}/${postPath}`;

        // ✅ FIX: HTML strip
        const cleanActor        = stripHtml(actorName)       || 'Someone';
        const cleanPostTitle    = stripHtml(postTitle);
        const cleanComment      = stripHtml(commentPreview);
        const pTitle            = cleanPostTitle ? `"${cleanPostTitle}"` : 'your post';

        let notifTitle, notifBody;
        if (type === 'like') {
            notifTitle = `❤️ ${cleanActor} liked your post`;
            notifBody  = `${cleanActor} liked ${pTitle}`;
        } else {
            notifTitle = `💬 ${cleanActor} commented on your post`;
            notifBody  = cleanComment
                ? `${cleanActor}: ${cleanComment.length > 80 ? cleanComment.substring(0, 80) + '…' : cleanComment}`
                : `${cleanActor} commented on ${pTitle}`;
        }

        const message = {
            notification: { title: notifTitle, body: notifBody },
            webpush: {
                notification: {
                    icon: getIcon(actorPhoto), badge: LOGO_URL,
                    requireInteraction: false,
                    tag: `${type}_${postId}_${actorUid || Date.now()}`,
                    renotify: true
                },
                fcmOptions: { link: clickUrl }
            },
            android: {
                priority: 'normal',
                notification: {
                    icon: 'ic_notification', color: '#e91e63',
                    channel_id: 'high_importance_channel',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                }
            },
            data: { type: `reaction_${type}`, postId: String(postId || ''), actorUid: String(actorUid || ''), clickUrl },
            token
        };

        const r = await admin.messaging().send(message);
        console.log(`✅ ${type} notification sent:`, postOwnerId, r);
        return res.status(200).json({ success: true, type });

    } catch (error) {
        console.error("❌ Reaction Notification Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});


// ══════════════════════════════════════════════════════════════════════════
// ROUTE 5 — /api  (backward compat)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api', async (req, res) => {
    const { targetToken, callerName, callerUid, callerPhoto, callType, action } = req.body;
    console.log("📞 /api call (legacy route):", { callerName, action });

    if (!targetToken) return res.status(400).json({ error: "targetToken is required" });

    if (action === 'cancel') {
        try {
            const msg = {
                data: { action: 'cancel_call', callerUid: String(callerUid || '') },
                android: { priority: 'high', ttl: '10s' },
                token: targetToken
            };
            await admin.messaging().send(msg);
            return res.status(200).json({ success: true, type: 'cancel' });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }

    try {
        const cleanCallerName = stripHtml(callerName) || 'Health Jobs User';
        const clickUrl        = `${BASE_URL}/chat.html?uid=${callerUid}&startCall=true&callType=${callType || 'audio'}&incoming=true`;
        const callEmoji       = callType === 'video' ? '🎥' : '📞';
        const callText        = callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';

        const msg = {
            notification: { title: `${callEmoji} ${cleanCallerName}`, body: callText },
            webpush: {
                notification: { icon: getIcon(callerPhoto), badge: LOGO_URL, requireInteraction: true },
                fcmOptions: { link: clickUrl }
            },
            android: {
                priority: 'high', ttl: '30s',
                notification: { channel_id: 'high_importance_channel', click_action: 'FLUTTER_NOTIFICATION_CLICK' }
            },
            data: { isCall: 'true', callerUid: String(callerUid || ''), callerName: cleanCallerName, callType: String(callType || 'audio') },
            token: targetToken
        };
        await admin.messaging().send(msg);
        return res.status(200).json({ success: true, type: 'call' });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});


export default app;
