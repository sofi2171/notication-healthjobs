import express from 'express';
import cors from 'cors';
import admin from 'firebase-admin';

const app = express();

// 1. Firebase Admin Init (Vercel Environment Variable se)
if (!admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase Admin Initialized Successfully");
    } catch (error) {
        console.error("Firebase Admin Init Error:", error.message);
    }
}

const db = admin.firestore();

// 2. Middleware
app.use(cors({ origin: '*' }));
app.use(express.json());

// 3. Main Route (/api/server)
app.all('/api/server', async (req, res) => {
    // GET request - Testing ke liye
    if (req.method === 'GET') {
        return res.status(200).send("API is Live and Ready!");
    }

    // POST request - Notification bhejne ke liye
    if (req.method === 'POST') {
        try {
            const { title, hospital } = req.body;
            console.log("New Post Received. Title:", title, "Hospital:", hospital);

            const tokens = [];
            const usersSnapshot = await db.collection('users').get();
            
            console.log("Total Users found in Database:", usersSnapshot.size);

            usersSnapshot.forEach(doc => {
                const userData = doc.data();
                if (userData.fcmToken) {
                    tokens.push(userData.fcmToken);
                }
            });

            console.log("Valid FCM Tokens found:", tokens.length);

            if (tokens.length === 0) {
                console.log("No tokens available to send notifications.");
                return res.status(200).json({ success: false, message: "No tokens found" });
            }

            // Notification ka Message Data
            const message = {
                notification: {
                    title: `Nayi Job: ${title}`,
                    body: `${hospital} ne Health Jobs par post lagayi hai.`
                },
                tokens: tokens 
            };

            // Notification Bhejna
            const response = await admin.messaging().sendEachForMulticast(message);
            console.log("Successfully sent:", response.successCount);
            console.log("Failed to send:", response.failureCount);

            return res.status(200).json({ 
                success: true, 
                sent: response.successCount, 
                failed: response.failureCount 
            });

        } catch (error) {
            console.error("Error sending notification:", error.message);
            return res.status(500).json({ error: error.message });
        }
    }
});

export default app;
