import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';

const app = express();

// 1. Firebase Admin Init
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } catch (error) {
        console.error("Init Error:", error.message);
    }
}

const db = admin.firestore();

// 2. Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// 3. Ye route lazmi hai taake URL hit ho sake
app.all('/api/server', async (req, res) => {
    if (req.method === 'GET') {
        return res.status(200).send("API is Live and Ready!");
    }

    if (req.method === 'POST') {
        try {
            const { title, hospital } = req.body;
            const tokens = [];
            const usersSnapshot = await db.collection('users').get();
            
            usersSnapshot.forEach(doc => {
                const userData = doc.data();
                if (userData.fcmToken) tokens.push(userData.fcmToken);
            });

            if (tokens.length === 0) {
                return res.status(200).json({ success: false, message: "No tokens found" });
            }

            const message = {
                notification: {
                    title: `Nayi Job: ${title}`,
                    body: `${hospital} ne post lagayi hai.`
                },
                tokens: tokens 
            };

            const response = await admin.messaging().sendEachForMulticast(message);
            return res.status(200).json({ success: true, sent: response.successCount });

        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }
});

export default app;
