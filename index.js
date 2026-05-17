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

// ─── Health Check ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send("✅ Health Jobs API is Live!"));
app.get('/api/server', (req, res) => res.send("✅ API is Live!"));

// ══════════════════════════════════════════════════════════════════════════
// ROUTE 1 — POST NOTIFICATION  (/api/server)
// جب کوئی نئی پوسٹ کرے تو باقی سب یوزرز کو نوٹیفکیشن جائے
// پوسٹ کرنے والے کو خود نوٹیفکیشن نہ جائے
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/server', async (req, res) => {
    try {
        const { title, hospital, body, postId, senderPhoto, posterId } = req.body;

        console.log("📢 Post Notification:", { title, hospital, postId, posterId });

        if (!postId) {
            return res.status(400).json({ success: false, message: "postId is required" });
        }

        // ✅ سب یوزرز کے tokens اکٹھے کرو — لیکن poster کو خود نوٹیفکیشن نہ جائے
        let tokens = [];
        const usersSnapshot = await db.collection('users').get();
        usersSnapshot.forEach(doc => {
            // ✅ پوسٹ کرنے والے کو خود نوٹیفکیشن نہ جائے
            if (posterId && doc.id === posterId) return;

            const token = doc.data().fcmToken;
            if (token) {
                if (Array.isArray(token)) tokens.push(...token);
                else tokens.push(token);
            }
        });

        const uniqueTokens = [...new Set(tokens)].filter(t => t && t.length > 10);
        console.log("🔑 Tokens found:", uniqueTokens.length);

        if (uniqueTokens.length === 0) {
            return res.status(200).json({ success: false, message: "No tokens found" });
        }

        // ✅ پوسٹ ڈیٹیلز پیج کا link
        const clickUrl = `https://healthjobs-portal.web.app/details.html?id=${postId}`;

        const message = {
            notification: {
                title: `${hospital || 'Health Jobs'}: ${title || 'New Medical Update'}`,
                body: body ? (body.length > 100 ? body.substring(0, 100) + '...' : body) : 'Tap to view the latest healthcare update.'
            },

            // ✅ Web push — icon پوسٹ کرنے والے کی اصل pic اور click سے سہی پوسٹ پر جائے
            webpush: {
                notification: {
                    icon: senderPhoto && senderPhoto.startsWith('http')
                        ? senderPhoto
                        : 'https://healthjobs-portal.web.app/images/logo.png',
                    badge: 'https://healthjobs-portal.web.app/images/logo.png',
                    requireInteraction: false
                },
                fcmOptions: {
                    link: clickUrl   // ✅ کلک کرنے پر سہی پوسٹ ڈیٹیل پیج کھلے
                }
            },

            // ✅ Android
            android: {
                priority: 'high',
                notification: {
                    icon: 'ic_notification',
                    color: '#0a66c2',
                    channel_id: 'high_importance_channel',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                }
            },

            // ✅ data payload — app side redirect کے لیے
            data: {
                postId:   String(postId || ''),
                type:     'general_post',
                clickUrl: clickUrl
            },

            tokens: uniqueTokens
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        console.log("✅ Sent:", response.successCount, "❌ Failed:", response.failureCount);

        // ✅ Invalid tokens Firestore سے ہٹاؤ
        if (response.failureCount > 0) {
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    const errCode = resp.error?.code;
                    if (
                        errCode === 'messaging/invalid-registration-token' ||
                        errCode === 'messaging/registration-token-not-registered'
                    ) {
                        console.warn("🗑️ Invalid token:", uniqueTokens[idx]);
                    }
                }
            });
        }

        return res.status(200).json({
            success: true,
            sent:   response.successCount,
            failed: response.failureCount
        });

    } catch (error) {
        console.error("❌ Post Notification Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════
// ROUTE 2 — CHAT MESSAGE NOTIFICATION  (/api/chat)
// جب کوئی نیا میسج بھیجے — صرف receiver کو نوٹیفکیشن جائے
// کلک کرنے پر chat.html کھلے اسی user کے ساتھ
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
    try {
        const { targetToken, senderName, senderUid, senderPhoto, roomId } = req.body;

        console.log("💬 Chat Notification:", { senderName, senderUid, roomId });

        if (!targetToken) {
            return res.status(400).json({ error: "targetToken is required" });
        }
        if (!senderUid) {
            return res.status(400).json({ error: "senderUid is required" });
        }

        // ✅ کلک کرنے پر اسی user کے ساتھ chat کھلے
        const clickUrl = `https://healthjobs-portal.web.app/chat.html?uid=${senderUid}`;

        const message = {
            notification: {
                title: `💬 ${senderName || 'Healthcare User'}`,
                body: 'You have a new message. Tap to reply.'
            },

            // ✅ icon sender کی اصل pic
            webpush: {
                notification: {
                    icon: senderPhoto && senderPhoto.startsWith('http')
                        ? senderPhoto
                        : 'https://healthjobs-portal.web.app/images/logo.png',
                    badge: 'https://healthjobs-portal.web.app/images/logo.png',
                    requireInteraction: false
                },
                fcmOptions: {
                    link: clickUrl   // ✅ کلک سے chat.html کھلے
                }
            },

            android: {
                priority: 'high',
                notification: {
                    icon: 'ic_notification',
                    color: '#0a66c2',
                    channel_id: 'high_importance_channel',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK'
                }
            },

            data: {
                type:      'chat_message',
                senderUid: String(senderUid || ''),
                roomId:    String(roomId    || ''),
                clickUrl:  clickUrl
            },

            token: targetToken  // ✅ صرف ایک receiver کو
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
// کال کا نوٹیفکیشن — صرف جس کو کال کی اسی کو جائے
// کلک کرنے پر chat.html کھلے incoming call کے ساتھ
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/call', async (req, res) => {
    try {
        const { targetToken, callerName, callerUid, callerPhoto, callType, action } = req.body;
        console.log("📞 Call request:", { callerName, callerUid, callType, action });

        if (!targetToken) {
            return res.status(400).json({ error: "targetToken is required" });
        }

        // ✅ Cancel call — صرف data signal بھیجو
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

        // ✅ Incoming call notification
        // کلک کرنے پر chat.html کھلے اور call شروع ہو
        const clickUrl = `https://healthjobs-portal.web.app/chat.html?uid=${callerUid}&startCall=true&callType=${callType || 'audio'}&incoming=true`;

        const callEmoji = callType === 'video' ? '🎥' : '📞';
        const callText  = callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';

        const msg = {
            // ✅ notification block — تاکہ title/body صحیح دکھے
            notification: {
                title: `${callEmoji} ${callerName || 'Health Jobs User'}`,
                body:  callText
            },

            // ✅ web push — caller کی اصل pic icon میں
            webpush: {
                notification: {
                    icon: callerPhoto && callerPhoto.startsWith('http')
                        ? callerPhoto
                        : 'https://healthjobs-portal.web.app/images/logo.png',
                    badge: 'https://healthjobs-portal.web.app/images/logo.png',
                    requireInteraction: true  // ✅ call notification dismiss نہ ہو جلدی
                },
                fcmOptions: {
                    link: clickUrl   // ✅ کلک سے incoming call screen کھلے
                }
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

            // ✅ data payload — app side کال handle کرنے کے لیے
            data: {
                isCall:     'true',
                callerUid:  String(callerUid  || ''),
                callerName: String(callerName || 'Health Jobs User'),
                callType:   String(callType   || 'audio'),
                clickUrl:   clickUrl
            },

            token: targetToken  // ✅ صرف جس کو کال کی اسی کو
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
// ROUTE 4 — /api  (backward compat — پرانے کوڈ کے لیے)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api', async (req, res) => {
    const { targetToken, callerName, callerUid, callType, action } = req.body;
    console.log("📞 /api call (old route):", { callerName, action });

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
        } catch(e) {
            return res.status(500).json({ error: e.message });
        }
    }

    try {
        const clickUrl = `https://healthjobs-portal.web.app/chat.html?uid=${callerUid}&startCall=true&callType=${callType || 'audio'}&incoming=true`;
        const callEmoji = callType === 'video' ? '🎥' : '📞';
        const callText  = callType === 'video' ? 'Incoming Video Call' : 'Incoming Audio Call';

        const msg = {
            notification: {
                title: `${callEmoji} ${callerName || 'Health Jobs User'}`,
                body:  callText
            },
            webpush: {
                notification: {
                    icon:  'https://healthjobs-portal.web.app/images/logo.png',
                    badge: 'https://healthjobs-portal.web.app/images/logo.png',
                    requireInteraction: true
                },
                fcmOptions: { link: clickUrl }
            },
            android: {
                priority: 'high',
                ttl: '30s',
                notification: {
                    channel_id: 'high_importance_channel',
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
    } catch(e) {
        return res.status(500).json({ error: e.message });
    }
});

export default app;
