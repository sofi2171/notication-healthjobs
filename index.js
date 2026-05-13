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
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/server', async (req, res) => {
    try {
        const { title, hospital, postId, senderPhoto } = req.body;
        console.log("📢 Post Notification:", title);

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
        console.log("🔑 Tokens:", uniqueTokens.length);

        if (uniqueTokens.length === 0) {
            return res.status(200).json({ success: false, message: "No tokens found" });
        }

        const message = {
            notification: {
                title: `New Opportunity: ${title}`,
                body: `${hospital} has posted a new job. Tap to view details.`
            },
            webpush: {
                notification: { icon: senderPhoto || "https://via.placeholder.com/150" },
                fcmOptions: { link: `https://healthjobs-portal.web.app/posts.html?id=${postId}` }
            },
            data: { postId: String(postId || '') },
            tokens: uniqueTokens
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        console.log("✅ Sent:", response.successCount, "❌ Failed:", response.failureCount);
        return res.status(200).json({ success: true, sent: response.successCount, failed: response.failureCount });

    } catch (error) {
        console.error("❌ Error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════
// ROUTE 2 — CALL NOTIFICATION  (/api/call)
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
                    action: "cancel_call",
                    callerUid: String(callerUid || '')
                },
                android: { priority: "high", ttl: "10s" },
                token: targetToken
            };
            const r = await admin.messaging().send(msg);
            console.log("✅ Cancel sent:", r);
            return res.status(200).json({ success: true, type: "cancel" });
        }

        // ✅ Incoming call — notification key BILKUL NAHI
        const msg = {
            data: {
                isCall:     "true",
                callerUid:  String(callerUid  || ''),
                callerName: String(callerName || 'Health Jobs User'),
                callType:   String(callType   || 'audio')
            },
            android: { priority: "high", ttl: "30s" },
            token: targetToken
        };

        const r = await admin.messaging().send(msg);
        console.log("✅ Call sent:", r);
        return res.status(200).json({ success: true, type: "call" });

    } catch (error) {
        console.error("❌ Call error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════
// ROUTE 3 — /api — purane code ke liye backward compat
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
                data: { action: "cancel_call", callerUid: String(callerUid || '') },
                android: { priority: "high", ttl: "10s" },
                token: targetToken
            };
            await admin.messaging().send(msg);
            return res.status(200).json({ success: true, type: "cancel" });
        } catch(e) {
            return res.status(500).json({ error: e.message });
        }
    }

    try {
        const msg = {
            data: {
                isCall:     "true",
                callerUid:  String(callerUid  || ''),
                callerName: String(callerName || 'Health Jobs User'),
                callType:   String(callType   || 'audio')
            },
            android: { priority: "high", ttl: "30s" },
            token: targetToken
        };
        await admin.messaging().send(msg);
        return res.status(200).json({ success: true, type: "call" });
    } catch(e) {
        return res.status(500).json({ error: e.message });
    }
});

export default app;
