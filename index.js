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
// simple.html se general post ka notification
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/server', async (req, res) => {
    try {
        // ✅ FIX 1: body field bhi lo (description ke liye)
        // ✅ FIX 2: senderPhoto bhi lo (poster ki real pic ke liye)
        const { title, hospital, body, postId, senderPhoto } = req.body;

        console.log("📢 Post Notification:", { title, hospital, postId });

        // ✅ FIX 3: Sabhi users ke tokens collect karo
        let tokens = [];
        const usersSnapshot = await db.collection('users').get();
        usersSnapshot.forEach(doc => {
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

        // ✅ FIX 4: Notification title mein hospital/poster name sahi aaye
        //           body mein post ki description aaye
        //           click karne par sahi post detail page khule
        const clickUrl = `https://healthjobs-portal.web.app/details.html?id=${postId}`;

        const message = {
            notification: {
                title: `${hospital || 'Health Jobs'}: ${title || 'New Medical Update'}`,
                body:  body || 'Tap to view the latest healthcare update.'
            },

            // ✅ FIX 5: webpush ke liye icon aur click link
            webpush: {
                notification: {
                    icon:  senderPhoto || 'https://healthjobs-portal.web.app/images/logo.png',
                    badge: 'https://healthjobs-portal.web.app/images/logo.png',
                    click_action: clickUrl
                },
                fcmOptions: {
                    link: clickUrl
                }
            },

            // ✅ FIX 6: Android ke liye click action — iske bina click kaam nahi karta
            android: {
                priority: 'high',
                notification: {
                    icon:         'ic_notification',
                    color:        '#0a66c2',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK',
                    channel_id:   'high_importance_channel'
                }
            },

            // ✅ FIX 7: data payload mein postId taake app side par redirect ho sake
            data: {
                postId:    String(postId   || ''),
                type:      'general_post',
                clickUrl:  clickUrl
            },

            tokens: uniqueTokens
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        console.log("✅ Sent:", response.successCount, "❌ Failed:", response.failureCount);

        // ✅ Failed tokens ko Firestore se hata do (invalid tokens saaf)
        if (response.failureCount > 0) {
            const batch = db.batch();
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    const errCode = resp.error?.code;
                    // Sirf permanently invalid tokens delete karo
                    if (
                        errCode === 'messaging/invalid-registration-token' ||
                        errCode === 'messaging/registration-token-not-registered'
                    ) {
                        console.warn("🗑️ Invalid token removed:", uniqueTokens[idx]);
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
// ROUTE 2 — CHAT REQUEST NOTIFICATION  (/api/chat)
// Jab koi naya chat request bheje, target user ko notification jaye
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/chat', async (req, res) => {
    try {
        const { targetToken, senderName, senderUid, senderPhoto, roomId } = req.body;

        console.log("💬 Chat Request Notification:", { senderName, senderUid, roomId });

        if (!targetToken) {
            return res.status(400).json({ error: "targetToken is required" });
        }

        // ✅ Sirf ek notification — double notification nahi aayega
        //    kyunki hum targetToken ko directly use kar rahe hain (broadcast nahi)
        const clickUrl = `https://healthjobs-portal.web.app/chat.html?uid=${senderUid}`;

        const message = {
            notification: {
                title: `${senderName || 'Healthcare User'} sent you a message`,
                body:  'Tap to open the conversation'
            },

            webpush: {
                notification: {
                    icon:  senderPhoto || 'https://healthjobs-portal.web.app/images/logo.png',
                    badge: 'https://healthjobs-portal.web.app/images/logo.png',
                    click_action: clickUrl
                },
                fcmOptions: {
                    link: clickUrl
                }
            },

            android: {
                priority: 'high',
                notification: {
                    icon:         'ic_notification',
                    color:        '#0a66c2',
                    click_action: 'FLUTTER_NOTIFICATION_CLICK',
                    channel_id:   'high_importance_channel'
                }
            },

            data: {
                type:      'chat_request',
                senderUid: String(senderUid || ''),
                roomId:    String(roomId    || ''),
                clickUrl:  clickUrl
            },

            token: targetToken   // ✅ broadcast nahi, sirf ek user ko
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
// Data-only — app band ho tab bhi kaam karta hai
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/call', async (req, res) => {
    try {
        const { targetToken, callerName, callerUid, callType, action } = req.body;
        console.log("📞 Call request:", { callerName, callerUid, callType, action });

        if (!targetToken) {
            return res.status(400).json({ error: "targetToken is required" });
        }

        // ✅ Cancel call
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

        // ✅ Incoming call — data-only (notification key bilkul nahi)
        const msg = {
            data: {
                isCall:     'true',
                callerUid:  String(callerUid  || ''),
                callerName: String(callerName || 'Health Jobs User'),
                callType:   String(callType   || 'audio')
            },
            android: { priority: 'high', ttl: '30s' },
            token: targetToken
        };

        const r = await admin.messaging().send(msg);
        console.log("✅ Call sent:", r);
        return res.status(200).json({ success: true, type: 'call' });

    } catch (error) {
        console.error("❌ Call error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════
// ROUTE 4 — /api  (backward compat — purana code ke liye)
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
        const msg = {
            data: {
                isCall:     'true',
                callerUid:  String(callerUid  || ''),
                callerName: String(callerName || 'Health Jobs User'),
                callType:   String(callType   || 'audio')
            },
            android: { priority: 'high', ttl: '30s' },
            token: targetToken
        };
        await admin.messaging().send(msg);
        return res.status(200).json({ success: true, type: 'call' });
    } catch(e) {
        return res.status(500).json({ error: e.message });
    }
});

export default app;
