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
    
    if (req.method === 'GET') {
        return res.status(200).send("API is Live and Ready!");
    }

    if (req.method === 'POST') {
        try {
            // Frontend se postId aur senderPhoto bhi receive karein
            const { title, hospital, postId, senderPhoto } = req.body;
            console.log("New Post Received. Title:", title, "Hospital:", hospital);

            let tokens = [];
            const usersSnapshot = await db.collection('users').get();
            
            usersSnapshot.forEach(doc => {
                const userData = doc.data();
                if (userData.fcmToken) {
                    // Agar array of tokens hai to spread karein, warna single push
                    if (Array.isArray(userData.fcmToken)) {
                        tokens.push(...userData.fcmToken);
                    } else {
                        tokens.push(userData.fcmToken);
                    }
                }
            });

            // FIX 1: Remove Duplicate Tokens
            // Agar ek user ka token 2 baar save ho gaya ho, to ye usay 1 kar dega
            const uniqueTokens = [...new Set(tokens)];
            console.log("Unique FCM Tokens found:", uniqueTokens.length);

            if (uniqueTokens.length === 0) {
                console.log("No tokens available to send notifications.");
                return res.status(200).json({ success: false, message: "No tokens found" });
            }

            // FIX 2, 3 & 4: Professional English, Icon, and Click Link
            const message = {
                notification: {
                    title: `New Opportunity: ${title}`,
                    body: `${hospital} has posted a new job. Tap to view details.`
                },
                webpush: {
                    notification: {
                        icon: senderPhoto || "https://via.placeholder.com/150", // Circular picture
                    },
                    fcmOptions: {
                        // Click karne par kahan redirect karna hai (Apna URL set karein)
                        link: `https://jobs-portal.web.app/job-details.html?id=${postId}` 
                    }
                },
                data: {
                    postId: String(postId) // App ke andar data handle karne ke liye
                },
                tokens: uniqueTokens 
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
