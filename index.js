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
const BASE_URL        = 'https://healthjobs-portal.web.app';
const LOGO_URL        = `${BASE_URL}/images/logo.png`;
const RATE_WINDOW_MS  = 10 * 60 * 1000;   // 10 منٹ
const RATE_LIMIT      = 5;                  // ایک window میں زیادہ سے زیادہ individual notifications
const DAILY_MAX       = 10;                 // ایک دن میں زیادہ سے زیادہ notifications per user

// ─── Health Check ──────────────────────────────────────────────────────────
app.get('/',          (req, res) => res.send("✅ Health Jobs API is Live!"));
app.get('/api/server',(req, res) => res.send("✅ API is Live!"));


// ══════════════════════════════════════════════════════════════════════════
// HELPER: valid icon URL یا logo fallback
// ══════════════════════════════════════════════════════════════════════════
function getIcon(photo) {
    return photo && photo.startsWith('http') ? photo : LOGO_URL;
}


// ══════════════════════════════════════════════════════════════════════════
// HELPER: per-user daily count چیک کرو اور بڑھاؤ
// returns true  → notification بھیجنا ٹھیک ہے
// returns false → daily limit پوری ہو گئی، skip کرو
// ══════════════════════════════════════════════════════════════════════════
async function checkAndIncrementDailyCount(uid) {
    const today = new Date().toISOString().split('T')[0];  // YYYY-MM-DD
    const ref   = db.collection('notif_daily_counts').doc(`${uid}_${today}`);

    try {
        const result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const count = snap.exists ? (snap.data().count || 0) : 0;
            if (count >= DAILY_MAX) return false;
            tx.set(ref, { count: count + 1, uid, date: today }, { merge: true });
            return true;
        });
        return result;
    } catch (e) {
        console.error("❌ Daily count error:", e.message);
        return true; // error پر block نہ کرو
    }
}


// ══════════════════════════════════════════════════════════════════════════
// HELPER: post notification deduplication
// postId کے لیے صرف ایک بار notification جائے
// returns true  → پہلی بار ہے، بھیجو
// returns false → پہلے بھیج چکے، skip کرو
// ══════════════════════════════════════════════════════════════════════════
async function acquirePostLock(postId) {
    const ref = db.collection('notif_sent_posts').doc(postId);
    try {
        const result = await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (snap.exists) return false;  // پہلے بھیج چکے
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
// HELPER: rate window چیک کرو — bundled notification کی ضرورت ہے؟
// Firestore میں ہر uid کے لیے window track کرو
// returns { shouldBundle: false }  → individual notification بھیجو
// returns { shouldBundle: true, count, posts } → bundled بھیجو
// ══════════════════════════════════════════════════════════════════════════
async function checkRateWindow(uid, postEntry) {
    const ref     = db.collection('notif_rate_windows').doc(uid);
    const nowMs   = Date.now();
    const cutoff  = nowMs - RATE_WINDOW_MS;

    try {
        const result = await db.runTransaction(async (tx) => {
            const snap    = await tx.get(ref);
            let entries   = snap.exists ? (snap.data().entries || []) : [];

            // پرانے entries ہٹاؤ جو window سے باہر ہیں
            entries = entries.filter(e => e.ts > cutoff);

            // نئی entry شامل کرو
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
            console.warn("🗑️ Removing invalid token:", tokens[i]);
            // تمام users میں یہ token تلاش کرو اور ہٹاؤ
            try {
                const snap = await db.collection('users')
                    .where('fcmToken', '==', tokens[i]).get();
                snap.forEach(doc => {
                    batch.update(doc.ref, { fcmToken: admin.firestore.FieldValue.delete() });
                    removed++;
                });
            } catch (_) {}
        }
    }
    if (removed > 0) {
        await batch.commit();
        console.log(`🗑️ Removed ${removed} invalid token(s) from Firestore`);
    }
}


// ══════════════════════════════════════════════════════════════════════════
// HELPER: تمام users کے tokens اکٹھے کرو (poster کو چھوڑ کر)
// returns Map: uid → { tokens: [], dailyOk: bool }
// ══════════════════════════════════════════════════════════════════════════
async function collectUserTokens(excludeUid = null) {
    const usersSnap = await db.collection('users').get();
    const userMap   = new Map();

    usersSnap.forEach(doc => {
        if (excludeUid && doc.id === excludeUid) return;
        const data  = doc.data();
        const raw   = data.fcmToken;
        if (!raw) return;

        const tokens = (Array.isArray(raw) ? raw : [raw])
            .filter(t => t && t.length > 10);
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

        if (!postId) {
            return res.status(400).json({ success: false, message: "postId is required" });
        }

        // ─── Deduplication: ایک postId کا notification صرف ایک بار ───
        const locked = await acquirePostLock(postId);
        if (!locked) {
            console.log("⚠️ Duplicate suppressed for postId:", postId);
            return res.status(200).json({ success: false, message: "Notification already sent for this post" });
        }

        // ─── Post click URL: slug ہو تو slug، ورنہ id ───
        const postPath = postSlug
            ? `post/${postSlug}`
            : `details.html?id=${postId}`;
        const clickUrl = `${BASE_URL}/${postPath}`;

        // ─── Users اکٹھے کرو ───
        const userMap = await collectUserTokens(posterId);
        console.log("👥 Users to notify:", userMap.size);

        if (userMap.size === 0) {
            return res.status(200).json({ success: false, message: "No users to notify" });
        }

        // ─── Post entry (rate window کے لیے) ───
        const postEntry = {
            postId,
            title:  title    || 'New Post',
            poster: hospital || 'Health Jobs',
            photo:  senderPhoto || LOGO_URL,
            url:    clickUrl
        };

        let totalSent   = 0;
        let totalFailed = 0;
        const allTokensUsed = [];
        const allResponses  = [];

        // ─── ہر user کے لیے rate check ───
        for (const [uid, { tokens }] of userMap) {

            // Daily limit چیک
            const dailyOk = await checkAndIncrementDailyCount(uid);
            if (!dailyOk) {
                console.log(`⛔ Daily limit reached for uid: ${uid}`);
                continue;
            }

            // Rate window چیک
            const { shouldBundle, count, posts } = await checkRateWindow(uid, postEntry);

            let msg;

            if (shouldBundle) {
                // ─── Bundled notification ───
                const names      = [...new Set(posts.map(p => p.poster))].slice(0, 3).join(', ');
                const bundleBody = `${count} new posts from ${names}${count > 3 ? ' & others' : ''}`;

                msg = {
                    notification: {
                        title: `📋 ${count} New Posts on Health Jobs`,
                        body:  bundleBody
                    },
                    webpush: {
                        notification: {
                            icon:               LOGO_URL,
                            badge:              LOGO_URL,
                            requireInteraction: false,
                            tag:                `bundle_${uid}`,  // پرانا bundle replace ہو
                            renotify:           true
                        },
                        fcmOptions: { link: `${BASE_URL}/index.html` }
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
                        type:    'bundle',
                        count:   String(count),
                        clickUrl:`${BASE_URL}/index.html`
                    },
                    tokens
                };
            } else {
                // ─── Individual notification ───
                const notifTitle = `${hospital || 'Health Jobs'}: ${title || 'New Medical Update'}`;
                const notifBody  = body
                    ? (body.length > 120 ? body.substring(0, 120) + '…' : body)
                    : 'Tap to view the latest healthcare update.';

                msg = {
                    notification: { title: notifTitle, body: notifBody },
                    webpush: {
                        notification: {
                            icon:               getIcon(senderPhoto),
                            badge:              LOGO_URL,
                            requireInteraction: false,
                            tag:                `post_${postId}`,  // same postId → replace
                        },
                        fcmOptions: { link: clickUrl }
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
                        postId,
                        type:    'general_post',
                        clickUrl
                    },
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

        // ─── Invalid tokens ہٹاؤ ───
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
// جب کوئی نیا میسج بھیجے — صرف receiver کو clickable notification
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
    try {
        const { receiverUid, targetToken, senderName, senderUid, senderPhoto, messagePreview } = req.body;
        console.log("💬 Chat Notification:", { senderName, senderUid, receiverUid });

        // targetToken براہ راست دیا یا receiverUid سے Firestore میں تلاش کریں
        let token = targetToken;
        if (!token && receiverUid) {
            const userDoc = await db.collection('users').doc(receiverUid).get();
            if (userDoc.exists) {
                const rawToken = userDoc.data().fcmToken;
                token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
            }
        }

        if (!token) {
            return res.status(400).json({ error: "No FCM token found for receiver" });
        }
        if (!senderUid) {
            return res.status(400).json({ error: "senderUid is required" });
        }

        // Daily limit چیک (receiverUid سے یا token hash سے)
        const limitKey = receiverUid || token.substring(0, 20);
        const dailyOk  = await checkAndIncrementDailyCount(`chat_${limitKey}`);
        if (!dailyOk) {
            return res.status(200).json({ success: false, message: "Daily limit reached" });
        }

        // کلک کرنے پر chat.html کھلے اسی sender کے ساتھ
        const clickUrl = `${BASE_URL}/chat.html?uid=${senderUid}`;

        const notifBody = messagePreview
            ? (messagePreview.length > 80 ? messagePreview.substring(0, 80) + '…' : messagePreview)
            : 'You have a new message. Tap to reply.';

        const message = {
            notification: {
                title: `💬 ${senderName || 'Healthcare User'}`,
                body:  notifBody
            },
            webpush: {
                notification: {
                    icon:               getIcon(senderPhoto),
                    badge:              LOGO_URL,
                    requireInteraction: false,
                    tag:                `chat_${senderUid}`,  // same sender → replace
                    renotify:           true
                },
                fcmOptions: { link: clickUrl }
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
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/call', async (req, res) => {
    try {
        const { targetToken, callerName, callerUid, callerPhoto, callType, action } = req.body;
        console.log("📞 Call request:", { callerName, callerUid, callType, action });

        if (!targetToken) {
            return res.status(400).json({ error: "targetToken is required" });
        }

        // ─── Cancel call ───
        if (action === 'cancel') {
            const msg = {
                data: {
                    action:    'cancel_call',
                    callerUid: String(callerUid || '')
                },
                android: { priority: 'high', ttl: '10s' },
                token: targetToken
            };
            const r = await admin.messaging().send(msg);
            console.log("✅ Cancel sent:", r);
            return res.status(200).json({ success: true, type: 'cancel' });
        }

        // ─── Incoming call ───
        const clickUrl   = `${BASE_URL}/chat.html?uid=${callerUid}&startCall=true&callType=${callType || 'audio'}&incoming=true`;
        const callEmoji  = callType === 'video' ? '🎥' : '📞';
        const callText   = callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';

        const msg = {
            notification: {
                title: `${callEmoji} ${callerName || 'Health Jobs User'}`,
                body:  callText
            },
            webpush: {
                notification: {
                    icon:               getIcon(callerPhoto),
                    badge:              LOGO_URL,
                    requireInteraction: true,  // call dismiss نہ ہو جلدی
                    tag:                `call_${callerUid}`
                },
                fcmOptions: { link: clickUrl }
            },
            android: {
                priority: 'high',
                ttl:      '30s',
                notification: {
                    icon:         'ic_notification',
                    color:        '#0a66c2',
                    channel_id:   'high_importance_channel',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                }
            },
            data: {
                isCall:     'true',
                callerUid:  String(callerUid  || ''),
                callerName: String(callerName || 'Health Jobs User'),
                callType:   String(callType   || 'audio'),
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
// جب کوئی like یا comment کرے — پوسٹ کے owner کو notification جائے
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/reaction', async (req, res) => {
    try {
        const {
            type,           // 'like' | 'comment'
            postId,
            postSlug,
            postTitle,
            postOwnerId,    // جس کی پوسٹ ہے
            actorName,      // جس نے like/comment کیا
            actorUid,
            actorPhoto,
            commentPreview  // comment کا text (optional)
        } = req.body;

        console.log("❤️ Reaction Notification:", { type, postId, postOwnerId, actorName });

        if (!postOwnerId) {
            return res.status(400).json({ error: "postOwnerId is required" });
        }
        if (!type || !['like', 'comment'].includes(type)) {
            return res.status(400).json({ error: "type must be 'like' or 'comment'" });
        }

        // خود اپنی پوسٹ پر like/comment پر notification نہ جائے
        if (actorUid && actorUid === postOwnerId) {
            return res.status(200).json({ success: false, message: "Self-reaction suppressed" });
        }

        // Daily limit چیک
        const dailyOk = await checkAndIncrementDailyCount(`reaction_${postOwnerId}`);
        if (!dailyOk) {
            return res.status(200).json({ success: false, message: "Daily limit reached" });
        }

        // Post owner کا FCM token
        const ownerDoc = await db.collection('users').doc(postOwnerId).get();
        if (!ownerDoc.exists) {
            return res.status(404).json({ error: "Post owner not found" });
        }
        const rawToken = ownerDoc.data().fcmToken;
        const token    = Array.isArray(rawToken) ? rawToken[0] : rawToken;

        if (!token) {
            return res.status(200).json({ success: false, message: "Owner has no FCM token" });
        }

        // Post click URL
        const postPath = postSlug
            ? `post/${postSlug}`
            : `details.html?id=${postId}`;
        const clickUrl = `${BASE_URL}/${postPath}`;

        // Notification content
        let notifTitle, notifBody;
        const actor = actorName || 'Someone';
        const pTitle = postTitle ? `"${postTitle}"` : 'your post';

        if (type === 'like') {
            notifTitle = `❤️ ${actor} liked your post`;
            notifBody  = `${actor} liked ${pTitle}`;
        } else {
            notifTitle = `💬 ${actor} commented on your post`;
            notifBody  = commentPreview
                ? `${actor}: ${commentPreview.length > 80 ? commentPreview.substring(0, 80) + '…' : commentPreview}`
                : `${actor} commented on ${pTitle}`;
        }

        const message = {
            notification: { title: notifTitle, body: notifBody },
            webpush: {
                notification: {
                    icon:               getIcon(actorPhoto),
                    badge:              LOGO_URL,
                    requireInteraction: false,
                    tag:                `${type}_${postId}_${actorUid || Date.now()}`,
                    renotify:           true
                },
                fcmOptions: { link: clickUrl }
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
                clickUrl
            },
            token
        };

        const r = await admin.messaging().send(message);
        console.log(`✅ ${type} notification sent to owner:`, postOwnerId, r);
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

    if (!targetToken) {
        return res.status(400).json({ error: "targetToken is required" });
    }

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
        const clickUrl  = `${BASE_URL}/chat.html?uid=${callerUid}&startCall=true&callType=${callType || 'audio'}&incoming=true`;
        const callEmoji = callType === 'video' ? '🎥' : '📞';
        const callText  = callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';

        const msg = {
            notification: {
                title: `${callEmoji} ${callerName || 'Health Jobs User'}`,
                body:  callText
            },
            webpush: {
                notification: {
                    icon:               getIcon(callerPhoto),
                    badge:              LOGO_URL,
                    requireInteraction: true
                },
                fcmOptions: { link: clickUrl }
            },
            android: {
                priority: 'high',
                ttl:      '30s',
                notification: {
                    channel_id:   'high_importance_channel',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                }
            },
            data: {
                isCall:     'true',
                callerUid:  String(callerUid  || ''),
                callerName: String(callerName || 'Health Jobs User'),
                callType:   String(callType   || 'audio')
            },
            token: targetToken
        };
        await admin.messaging().send(msg);
        return res.status(200).json({ success: true, type: 'call' });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});


export default app;
