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

// ─── Health Check ──────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send("API is Live!"));
app.get('/api/server', (req, res) => res.send("API is Live!"));

// ══════════════════════════════════════════════════════════════════════════
// ROUTE 1 — POST NOTIFICATION  (/api/server)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api/server', async (req, res) => {
    try {
        const { title, hospital, postId, senderPhoto } = req.body;
        console.log("New Post Notification. Title:", title);

        // Collect all FCM tokens
        let tokens = [];
        const usersSnapshot = await db.collection('users').get();
        usersSnapshot.forEach(doc => {
            const token = doc.data().fcmToken;
            if (token) {
                if (Array.isArray(token)) tokens.push(...token);
                else tokens.push(token);
            }
        });

        const uniqueTokens = [...new Set(tokens)];
        console.log("Tokens found:", uniqueTokens.length);

        if (uniqueTokens.length === 0) {
            return res.status(200).json({ success: false, message: "No tokens found" });
        }

        const message = {
            notification: {
                title: `New Opportunity: ${title}`,
                body: `${hospital} has posted a new job. Tap to view details.`
            },
            webpush: {
                notification: {
                    icon: senderPhoto || "https://via.placeholder.com/150"
                },
                fcmOptions: {
                    link: `https://healthjobs-portal.web.app/posts.html?id=${postId}`
                }
            },
            data: {
                postId: String(postId || '')
            },
            tokens: uniqueTokens
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        console.log("Sent:", response.successCount, "Failed:", response.failureCount);

        return res.status(200).json({
            success: true,
            sent: response.successCount,
            failed: response.failureCount
        });

    } catch (error) {
        console.error("Post notification error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

// ══════════════════════════════════════════════════════════════════════════
// ROUTE 2 — CALL NOTIFICATION  (/api)
// ══════════════════════════════════════════════════════════════════════════
app.post('/api', async (req, res) => {
    try {
        const { targetToken, callerName, callerUid, callType, action } = req.body;

        if (!targetToken) {
            return res.status(400).json({ error: "targetToken is required" });
        }

        // ✅ Cancel call
        if (action === 'cancel') {
            const cancelMessage = {
                // ✅ notification key nahi — data-only
                data: {
                    action: "cancel_call",
                    callerUid: String(callerUid || '')
                },
                android: {
                    priority: "high",
                    ttl: 10000
                },
                token: targetToken
            };

            const response = await admin.messaging().send(cancelMessage);
            console.log("Cancel call sent:", response);
            return res.status(200).json({ success: true, type: "cancel" });
        }

        // ✅ Incoming call — data-only message (notification key nahi)
        const callMessage = {
            // ✅ notification key bilkul nahi — FCM service ko khud handle karna hai
            data: {
                isCall:     "true",
                callerUid:  String(callerUid  || ''),
                callerName: String(callerName || 'Health Jobs User'),
                callType:   String(callType   || 'audio')
            },
            android: {
                priority: "high",
                ttl: 30000
            },
            token: targetToken
        };

        const response = await admin.messaging().send(callMessage);
        console.log("Call notification sent:", response);

        return res.status(200).json({ success: true, type: "call", response });

    } catch (error) {
        console.error("Call notification error:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

export default app;
