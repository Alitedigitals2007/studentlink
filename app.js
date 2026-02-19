process.env.TZ = "Africa/Lagos";

console.log("Server initialized in Nigeria Time:", new Date().toString());

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const db = require('./db');

// 1. MIDDLEWARE SETUP
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views')); 
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    secret: process.env.SESSION_SECRET || 'alite_secret_key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// 2. STORAGE SETUP
const uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Creates unique name: profile-1712345678.jpg
        cb(null, file.fieldname + '-' + Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // Limit 5MB
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.set('view engine', 'ejs');
app.use(express.static('public'));
app.get('/', (req, res) => {
    res.render('welcome'); 
});

app.post('/register', async (req, res) => {
    // 1. Destructure the names exactly as they appear in the HTML "name" attributes
    const { fullName, whatsapp, university, department, level, password } = req.body;

    // DEBUG: This line will show you what the server is receiving in the terminal
    console.log("Receiving Data:", req.body);

    try {
        await db.query(
            'INSERT INTO users (fullname, whatsapp, university, department, level, password) VALUES ($1, $2, $3, $4, $5, $6)',
            [fullName, whatsapp, university, department, level, password]
        );
        res.redirect('/login');
    } catch (err) {
        console.error("❌ Error:", err.message);
        res.status(500).send(`Registration Failed: ${err.message}`);
    }
});

app.use(session({
    secret: 'alite_secret_key_123', // Change this to any random string
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true if using HTTPS
}));

// 2. The Login POST Route
app.post('/login', async (req, res) => {
    const { whatsapp, password } = req.body;

    try {
        // Look for the user in Neon
        const result = await db.query(
            'SELECT * FROM users WHERE whatsapp = $1 AND password = $2', 
            [whatsapp, password]
        );

        if (result.rows.length > 0) {
            // User found! Store their info in a session
            req.session.user = result.rows[0];
            
            console.log(`Success: ${req.session.user.fullname} logged in!`);
            res.redirect('/timeline'); // Send them to the main app
        } else {
            // No match found
            res.send("<script>alert('Wrong number or password!'); window.location='/login';</script>");
        }
    } catch (err) {
        console.error(err);
        res.status(500).send("Database error occurred.");
    }
});

// 3. Logout Route (Bonus)
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Protection Middleware: Only logged-in students can see the timeline
function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.redirect('/login');
}

// THE TIMELINE ROUTE
app.get('/timeline', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const userId = req.session.user.id;

    try {
        // 1. Get Posts with User Info and Like Counts
        const postsRes = await db.query(`
            SELECT p.*, u.fullname, u.profile_pic, u.university,
            (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count,
            EXISTS(SELECT 1 FROM likes WHERE post_id = p.id AND user_id = $1) as user_has_liked
            FROM posts p JOIN users u ON p.user_id = u.id 
            ORDER BY p.created_at DESC`, [userId]);

        // 2. Get Upcoming Events
        const eventsRes = await db.query("SELECT * FROM events WHERE event_date >= NOW() ORDER BY event_date ASC LIMIT 5");

        // 3. Get Notification & Request Counts (The Dots)
        const notifRes = await db.query("SELECT COUNT(*) FROM notifications WHERE receiver_id = $1 AND is_read = false", [userId]);
        const friendRes = await db.query("SELECT COUNT(*) FROM friend_requests WHERE receiver_id = $1 AND status = 'pending'", [userId]);

        res.render('timeline', {
            user: req.session.user,
            posts: postsRes.rows,
            events: eventsRes.rows,
            notifCount: parseInt(notifRes.rows[0].count),
            friendRequests: parseInt(friendRes.rows[0].count)
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error");
    }
});

// THE SAVING ROUTE (Handles Text + Image)
app.post('/post', upload.single('post_media'), async (req, res) => {
    const { content } = req.body; 
    const userId = req.session.user.id;
    const mediaUrl = req.file ? `/uploads/${req.file.filename}` : null;

    await db.query("INSERT INTO posts (user_id, content, media_url) VALUES ($1, $2, $3)", [userId, content, mediaUrl]);
    res.redirect('/timeline');
});

// 3. LIKE SYSTEM
// LIKE ROUTE
app.post('/like/:postId', async (req, res) => {
    const userId = req.session.user.id;
    const postId = req.params.postId;

    try {
        const check = await db.query("SELECT * FROM likes WHERE post_id=$1 AND user_id=$2", [postId, userId]);
        
        if (check.rows.length > 0) {
            await db.query("DELETE FROM likes WHERE post_id=$1 AND user_id=$2", [postId, userId]);
            return res.json({ liked: false, count: (await getLikes(postId)) });
        } else {
            await db.query("INSERT INTO likes (post_id, user_id) VALUES ($1, $2)", [postId, userId]);
            
            // SEND NOTIFICATION
            const postOwner = await db.query("SELECT user_id FROM posts WHERE id=$1", [postId]);
            if(postOwner.rows[0].user_id !== userId) {
                await db.query("INSERT INTO notifications (receiver_id, sender_id, post_id, type) VALUES ($1, $2, $3, $4)", 
                [postOwner.rows[0].user_id, userId, postId, 'like']);
            }
            
            res.json({ liked: true, count: (await getLikes(postId)) });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Helper function
async function getLikes(postId) {
    const res = await db.query("SELECT COUNT(*) FROM likes WHERE post_id=$1", [postId]);
    return res.rows[0].count;
}

app.post('/post', isAuthenticated, async (req, res) => {
    const { content } = req.body;
    const user = req.session.user;

    try {
        await db.query(
            'INSERT INTO posts (user_id, author_name, author_university, content) VALUES ($1, $2, $3, $4)',
            [user.id, user.fullname, user.university, content]
        );
        res.redirect('/timeline');
    } catch (err) {
        console.error(err);
        res.send("Error posting update.");
    }
});

// This is the route all users see
app.get('/events', async (req, res) => {
    try {
        // Only select events that have been approved (status = 'active')
        const result = await db.query(
            "SELECT * FROM events WHERE status = 'active' ORDER BY event_date ASC"
        );
        
        res.render('events', { 
            events: result.rows,
            user: req.session.user 
        });
    } catch (err) {
        console.error("Error fetching user events:", err);
        res.status(500).send("Could not load events.");
    }
});

// Show the form to add an event
app.get('/events/add', isAuthenticated, (req, res) => {
    res.render('add-event', { user: req.session.user });
});


/// 1. ADD EVENT (User Side)
app.post('/events/add', isAuthenticated, upload.single('event_image'), async (req, res) => {
    const { title, date, location, description, link } = req.body;
    const user = req.session.user;
    const imagePath = req.file ? `/uploads/${req.file.filename}` : null;

    // Check if user is admin or Alite for auto-approval
    const isAlite = user.fullname.includes('Alite') || user.role === 'admin';
    const approvedStatus = isAlite ? true : false;

    try {
        await db.query(
            `INSERT INTO events (title, event_date, location, description, event_link, event_image, uni_name, submitted_by, is_approved) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [title, date, location, description, link, imagePath, 'All', user.id, approvedStatus]
        );

        // Success Alert Script
        res.send(`
            <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
            <body style="background:#0f172a">
            <script>
                Swal.fire({
                    title: 'Posted Successfully!',
                    text: '${isAlite ? "Event is live." : "Waiting for Alite to approve."}',
                    icon: 'success',
                    background: '#1e293b', color: '#fff', confirmButtonColor: '#00f2fe'
                }).then(() => { window.location.href = '/timeline'; });
            </script>
            </body>
        `);
    } catch (err) {
        res.status(500).send("Database Error");
    }
});

// Middleware to check if user is Alite
const isAdmin = (req, res, next) => {
    // FIXED: Changed .phone to .whatsapp to match your database column
    if (req.session.user && req.session.user.whatsapp === '09154681851') {
        next(); // Welcome, Alite Boss. Proceed to dashboard.
    } else {
        res.status(403).send("Unauthorized: This area is for Alite only.");
    }
};
// The Admin Home Page Route
app.get('/admin/dashboard', isAdmin, async (req, res) => {
    try {
        // Fetch Real-time Analytics
        const userCount = await db.query("SELECT COUNT(*) FROM users");
        const quizCount = await db.query("SELECT COUNT(*) FROM quizzes");
        const eventCount = await db.query("SELECT COUNT(*) FROM events");
        
        // Get top university
        const schoolStats = await db.query("SELECT university, COUNT(*) as count FROM users GROUP BY university ORDER BY count DESC LIMIT 1");

        res.render('admin-home', {
            user: req.session.user,
            stats: {
                totalUsers: userCount.rows[0].count,
                totalQuizzes: quizCount.rows[0].count,
                totalEvents: eventCount.rows[0].count,
                topUni: schoolStats.rows[0] ? schoolStats.rows[0].university : 'N/A'
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Server Error in Command Center");
    }
});

app.get('/admin/dashboard', (req, res) => {
    // We check for your WhatsApp number directly to be 100% safe
    if (req.session.user && req.session.user.whatsapp === '09154681851') {
        res.render('admin_dashboard', { user: req.session.user });
    } else {
        res.send("Unauthorized: This area is for Admin only.");
    }
    console.log("Current User Session:", req.session.user);
});

// GET the management page
app.get('/admin/manage-events', isAdmin, async (req, res) => {
    try {
        // Change 'pool' to 'db' (or whatever name you used at the top of app.js)
        const result = await db.query('SELECT * FROM events ORDER BY id DESC');
        
        res.render('manage-events', { 
            events: result.rows,
            user: req.session.user 
        });
    } catch (err) {
        console.error("DETAILED ERROR:", err);
        res.status(500).send("Error loading events.");
    }
});

/// --- EVENT MANAGEMENT ---
app.post('/admin/approve-event/:id', isAdmin, async (req, res) => {
    try {
        await db.query("UPDATE events SET is_approved = true WHERE id = $1", [req.params.id]);
        res.redirect('/admin/manage-events');
    } catch (err) {
        res.status(500).send("Error approving event");
    }
});

// Delete an event
app.post('/admin/delete-event/:id', isAdmin, async (req, res) => {
    try {
        await db.query('DELETE FROM events WHERE id = $1', [req.params.id]);
        res.redirect('/admin/manage-events');
    } catch (err) {
        res.status(500).send("Error deleting event");
    }
});

// --- BROADCAST SYSTEM ---
app.post('/admin/broadcast', isAdmin, async (req, res) => {
    const { title, message } = req.body;
    try {
        // The column names here must match the SQL exactly
        await db.query(
            `INSERT INTO notifications (user_id, title, message) 
             SELECT id, $1, $2 FROM users`,
            [title, message]
        );
        
        res.send("<script>alert('Broadcast Successful!'); window.location.href='/admin/dashboard';</script>");
    } catch (err) {
        console.error(err);
        res.status(500).send("System Error: " + err.message);
    }
});

app.get('/notifications', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        
        // Fetch notifications for the logged-in student
        const result = await db.query(
            "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC",
            [userId]
        );

        // Always pass the rows, even if it's an empty array
        res.render('notifications', { 
            notifications: result.rows || [],
            user: req.session.user 
        });

    } catch (err) {
        console.error("ALITE_SYSTEM_ERROR:", err);
        // Fallback to prevent the "Error loading alerts" white screen
        res.render('notifications', { 
            notifications: [], 
            error: "Could not sync notifications." 
        });
    }
});

// MARK ALL AS READ (Clear)
app.post('/notifications/mark-all-read', isAuthenticated, async (req, res) => {
    try {
        await db.query(
            "UPDATE notifications SET is_read = true WHERE user_id = $1",
            [req.session.user.id]
        );
        res.redirect('/notifications');
    } catch (err) {
        res.status(500).send("Error clearing notifications");
    }
});

// GET: Admin User Management Page
app.get('/admin/verify-users', isAdmin, async (req, res) => {
    try {
        const result = await db.query(
            "SELECT id, fullname, university, whatsapp, is_verified FROM users ORDER BY is_verified ASC, fullname ASC"
        );
        res.render('admin-verify', { users: result.rows });
    } catch (err) {
        res.status(500).send("Error fetching users");
    }
});

// POST: Toggle Verification
app.post('/admin/toggle-verify/:id', isAdmin, async (req, res) => {
    try {
        const userId = req.params.id;
        await db.query(
            "UPDATE users SET is_verified = NOT is_verified WHERE id = $1", 
            [userId]
        );
        res.redirect('/admin/verify-users');
    } catch (err) {
        res.status(500).send("Update failed");
    }
});

// This route handles the actual button click
app.post('/admin/toggle-verify', isAdmin, async (req, res) => {
    try {
        const { studentId } = req.body; // Getting ID from hidden input
        
        console.log("ALITE_ADMIN: Toggling user", studentId);

        await db.query(
            "UPDATE users SET is_verified = NOT is_verified WHERE id = $1", 
            [studentId]
        );

        res.redirect('/admin/verify-users');
    } catch (err) {
        console.error("ALITE_ERROR:", err);
        res.status(500).send("Database Error: " + err.message);
    }
});

app.get('/friends', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;

        

        // 1. Pending Requests (People who toasted you)
        const requests = await db.query(
            "SELECT fr.id AS request_id, u.fullname, u.university, u.id AS sender_id FROM friend_requests fr JOIN users u ON fr.sender_id = u.id WHERE fr.receiver_id = $1 AND fr.status = 'pending'",
            [userId]
        );

        // 2. Confirmed Friends (Your actual squad)
        const friends = await db.query(
            `SELECT u.id, u.fullname, u.university, u.is_verified, u.department 
             FROM friend_requests fr 
             JOIN users u ON (u.id = fr.sender_id OR u.id = fr.receiver_id)
             WHERE (fr.sender_id = $1 OR fr.receiver_id = $1) 
             AND fr.status = 'accepted' AND u.id != $1`,
            [userId]
        );

const recentChats = await db.query(
    `SELECT DISTINCT ON (u.id) 
        u.id, 
        u.fullname, 
        m.message, 
        m.created_at,
        (m.receiver_id = $1 AND m.is_read = false) as unread 
     FROM messages m
     JOIN users u ON (u.id = m.sender_id OR u.id = m.receiver_id)
     WHERE (m.sender_id = $1 OR m.receiver_id = $1) AND u.id != $1
     ORDER BY u.id, m.created_at DESC`,
    [userId]
);
 // 4. Discovery (Random people)
        const discovery = await db.query("SELECT id, fullname, university FROM users WHERE id != $1 LIMIT 6", [userId]);

        res.render('friends', {
            requests: requests.rows,
            friends: friends.rows,
            recentChats: recentChats.rows,
            users: discovery.rows,
            user: req.session.user
        });
    } catch (err) {
        res.status(500).send("Error loading Network");
    }
});

// ✅ 1. STATIC ROUTES FIRST
app.get('/profile/edit', async (req, res) => {
    try {
        if (!req.session.user) return res.redirect('/login');

        // Fetch fresh data from DB to ensure it's up to date
        const result = await db.query("SELECT * FROM users WHERE id = $1", [req.session.user.id]);
        const user = result.rows[0];

        res.render('edit-profile', { user: user });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading edit page");
    }
});

// 1. VIEW PROFILE
app.get('/profile/:id', async (req, res) => {
    const profileId = req.params.id;
    const viewerId = req.session.user.id;

    try {
        // 1. Get user details
        const userRes = await db.query("SELECT * FROM users WHERE id = $1", [profileId]);
        if (userRes.rows.length === 0) return res.status(404).send("User not found");

        const profileUser = userRes.rows[0];

        // 2. Get posts by this user
        const postsRes = await db.query(`
            SELECT p.*, u.fullname, u.profile_pic, 
            (SELECT COUNT(*) FROM likes WHERE post_id = p.id) as like_count
            FROM posts p JOIN users u ON p.user_id = u.id 
            WHERE p.user_id = $1 ORDER BY p.created_at DESC`, [profileId]);

        res.render('profile', {
            user: req.session.user, // The person logged in
            profileUser: profileUser, // The person whose profile we are looking at
            posts: postsRes.rows
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading profile");
    }
});

// POST: Update Profile Details
app.post('/profile/update-academic', isAuthenticated, async (req, res) => {
    try {
        const { department, level } = req.body;
        const userId = req.session.user.id;

        await db.query(
            "UPDATE users SET department = $1, level = $2 WHERE id = $3",
            [department, level, userId]
        );

        res.redirect(`/profile/${userId}`);
    } catch (err) {
        res.status(500).send("Update failed");
    }
});

app.post('/comment/:postId', async (req, res) => {
    const { content } = req.body;
    const { postId } = req.params;
    const userId = req.session.user.id;

    try {
        await db.query("INSERT INTO comments (post_id, user_id, content) VALUES ($1, $2, $3)", 
            [postId, userId, content]);
        res.sendStatus(200); // Tells the frontend "Success!"
    } catch (err) {
        console.error(err);
        res.status(500).send("Comment failed");
    }
});

// 2. SEND REQUEST
app.post('/friend-request/send/:id', isAuthenticated, async (req, res) => {
    try {
        await db.query("INSERT INTO friend_requests (sender_id, receiver_id) VALUES ($1, $2)", [req.session.user.id, req.params.id]);
        
        // Also create a notification for the receiver
        await db.query("INSERT INTO notifications (user_id, title, message) VALUES ($1, $2, $3)", 
            [req.params.id, "New Friend Request", `${req.session.user.fullname} wants to connect with you.`]);
        
        res.redirect(`/profile/${req.params.id}`);
    } catch (err) { res.redirect('back'); }
});

// ACCEPT REQUEST
app.post('/friends/accept/:id', isAuthenticated, async (req, res) => {
    try {
        await db.query(
            "UPDATE friend_requests SET status = 'accepted' WHERE id = $1",
            [req.params.id]
        );
        res.redirect('/friends');
    } catch (err) {
        res.redirect('/friends');
    }
});

// REJECT REQUEST
app.post('/friends/reject/:id', isAuthenticated, async (req, res) => {
    try {
        await db.query("DELETE FROM friend_requests WHERE id = $1", [req.params.id]);
        res.redirect('/friends');
    } catch (err) {
        res.redirect('/friends');
    }
});

// Add this before your routes
app.use(async (req, res, next) => {
    if (req.session.user) {
        const userId = req.session.user.id;
        try {
            // Count pending requests
            const fCount = await db.query("SELECT COUNT(*) FROM friend_requests WHERE receiver_id = $1 AND status = 'pending'", [userId]);
            // Count unread messages
            const mCount = await db.query("SELECT COUNT(*) FROM messages WHERE receiver_id = $1 AND is_read = false", [userId]);
            
            res.locals.friendCount = parseInt(fCount.rows[0].count);
            res.locals.msgCount = parseInt(mCount.rows[0].count);
        } catch (err) {
            res.locals.friendCount = 0;
            res.locals.msgCount = 0;
        }
    } else {
        res.locals.friendCount = 0;
        res.locals.msgCount = 0;
    }
    next();
});

// Open Chat Room
app.get('/chat/:id', isAuthenticated, async (req, res) => {
    try {
        const partnerId = req.params.id;
        const myId = req.session.user.id;

        await db.query(
        "UPDATE messages SET is_read = true WHERE sender_id = $1 AND receiver_id = $2",
        [partnerId, myId]
    );
        // 1. Get the partner's info
        const partnerRes = await db.query("SELECT id, fullname FROM users WHERE id = $1", [partnerId]);
        
        // 2. Get message history between US
        const msgRes = await db.query(
            `SELECT * FROM messages 
             WHERE (sender_id = $1 AND receiver_id = $2) 
             OR (sender_id = $2 AND receiver_id = $1) 
             ORDER BY created_at ASC`,
            [myId, partnerId]
        );

        res.render('chat', { 
            partner: partnerRes.rows[0], 
            messages: msgRes.rows, 
            user: req.session.user 
        });
    } catch (err) {
        res.status(500).send("Chat Error");
    }
});

// Send Private Message
app.post('/chat/send/:id', isAuthenticated, async (req, res) => {
    const { message } = req.body;
    await db.query(
        "INSERT INTO messages (sender_id, receiver_id, message) VALUES ($1, $2, $3)",
        [req.session.user.id, req.params.id, message]
    );
    res.redirect(`/chat/${req.params.id}`);
});

app.get('/resources', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    try {
        const result = await db.query("SELECT * FROM resources ORDER BY created_at DESC");
        res.render('resources', { 
            user: req.session.user, 
            resources: result.rows 
        });
    } catch (err) {
        console.error(err);
        res.render('resources', { user: req.session.user, resources: [] });
    }
});
// Add this to your app.js file
app.post('/upload-resource', async (req, res) => {
    // 1. Check if user is logged in
    if (!req.session.user) {
        return res.status(401).send("Please login first");
    }

    const { title, course_code, download_url } = req.body;
    const userId = req.session.user.id;

    try {
        // 2. Insert into the database
        await db.query(
            "INSERT INTO resources (title, course_code, download_url, uploaded_by) VALUES ($1, $2, $3, $4)",
            [title, course_code, download_url, userId]
        );
        
        // 3. Send them back to the vault to see their new upload
        res.redirect('/resources');
    } catch (err) {
        console.error("Database Error:", err);
        res.status(500).send("Something went wrong while saving to the Vault.");
    }
});

app.post('/update-profile', upload.single('profile_image'), async (req, res) => {
    const { fullname, university, department, level, whatsapp, bio } = req.body;
    const userId = req.session.user.id;
    let profilePic = req.session.user.profile_pic;

    if (req.file) {
        profilePic = `/uploads/${req.file.filename}`;
    }

    try {
        await db.query(`
            UPDATE users 
            SET fullname = $1, university = $2, department = $3, 
                level = $4, whatsapp = $5, bio = $6, profile_pic = $7 
            WHERE id = $8`, 
            [fullname, university, department, level, whatsapp, bio, profilePic, userId]
        );

        // Update the session so the user sees changes immediately
        req.session.user = { 
            ...req.session.user, 
            fullname, university, department, level, whatsapp, bio, profile_pic: profilePic 
        };

        res.redirect(`/profile/${userId}`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Update failed");
    }
});

// --- AUTH ROUTES ---

app.get('/login', (req, res) => res.render('login'));

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await db.query("SELECT * FROM users WHERE email = $1", [email]);
        const user = result.rows[0];
        
        if (user && user.password === password) { // Use bcrypt in production!
            req.session.user = user;
            return res.redirect(user.role === 'admin' ? '/admin/quizzes' : '/dashboard');
        }
        res.redirect('/login');
    } catch (err) {
        res.status(500).send("Login Error");
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// --- STUDENT ROUTES ---
app.get('/dashboard', isUser, async (req, res) => {
    try {
        // 1. Manually create the current Nigeria Time string
        // This ensures the server tells the DB exactly what time it is in Lagos
        const nigeriaTime = new Date().toLocaleString("en-US", {timeZone: "Africa/Lagos"});
        const currentTime = new Date(nigeriaTime);

        // 2. Optimized SQL Query using the server's calculated time
        const quizzesQuery = `
            SELECT *,
            CASE 
                WHEN $1 < start_time THEN 'upcoming'
                WHEN $1 BETWEEN start_time AND end_time THEN 'live'
                ELSE 'closed'
            END as status
            FROM quiz_sessions 
            ORDER BY 
                (CASE WHEN $1 BETWEEN start_time AND end_time THEN 1 
                      WHEN $1 < start_time THEN 2 
                      ELSE 3 END), 
                start_time ASC
        `;
        
        const quizzes = await db.query(quizzesQuery, [currentTime]);
        
        // 3. Fetch Leaderboard
        const leaderboard = await db.query(`
            SELECT u.fullname, a.score 
            FROM quiz_attempts a 
            JOIN users u ON a.user_id = u.id 
            ORDER BY a.score DESC LIMIT 10
        `);
        
        res.render('dashboard', { 
            user: req.session.user, 
            quizzes: quizzes.rows, 
            leaderboard: leaderboard.rows 
        });
    } catch (err) {
        console.error("Dashboard Error:", err);
        res.status(500).send("Error loading dashboard");
    }
});

app.get('/quiz/instructions/:id', isUser, async (req, res) => {
    try {
        const result = await db.query("SELECT * FROM quiz_sessions WHERE id = $1", [req.params.id]);
        res.render('instructions', { quiz: result.rows[0], user: req.session.user });
    } catch (err) {
        res.redirect('/dashboard');
    }
});

app.get('/quiz/start/:id', isUser, async (req, res) => {
    try {
        const sessionId = req.params.id;
        const quiz = await db.query("SELECT * FROM quiz_sessions WHERE id = $1", [sessionId]);
        const questions = await db.query("SELECT * FROM quizzes WHERE session_id = $1 ORDER BY RANDOM()", [sessionId]);
        
        res.render('quiz-page', { 
            user: req.session.user,
            quiz: quiz.rows[0],
            sessionId: sessionId,
            questions: questions.rows 
        });
    } catch (err) {
        res.redirect('/dashboard');
    }
});

app.post('/quiz/submit/:id', isUser, async (req, res) => {
    try {
        const sessionId = req.params.id;
        const userId = req.session.user.id; // Ensure session exists
        const answers = req.body;

        // 1. Get correct answers from DB
        const questions = await db.query("SELECT id, correct_option FROM quizzes WHERE session_id = $1", [sessionId]);
        const quizInfo = await db.query("SELECT title FROM quiz_sessions WHERE id = $1", [sessionId]);

        let score = 0;
        questions.rows.forEach(q => {
            const submittedAnswer = answers[`q${q.id}`]; // The "name" in HTML is q + ID
            if (submittedAnswer && submittedAnswer === q.correct_option) {
                score++;
            }
        });

        // 2. Save result to DB
        await db.query(
            "INSERT INTO quiz_attempts (user_id, session_id, score, finish_time) VALUES ($1, $2, $3, NOW())",
            [userId, sessionId, score]
        );

        // 3. Render results
        res.render('result', {
            score: score,
            total: questions.rows.length,
            quizTitle: quizInfo.rows[0].title
        });

    } catch (err) {
        console.error("SUBMISSION ERROR:", err);
        res.status(500).send("Something went wrong during grading. Please contact Admin.");
    }
});

app.get('/leaderboard', isUser, async (req, res) => {
    const result = await db.query("SELECT u.fullname, MAX(a.score) as top_score FROM quiz_attempts a JOIN users u ON a.user_id = u.id GROUP BY u.id ORDER BY top_score DESC LIMIT 20");
    res.render('leaderboard', { user: req.session.user, winners: result.rows });
});

// --- ADMIN ROUTES ---

app.get('/admin/quizzes', isAdmin, async (req, res) => {
    const sessions = await db.query("SELECT * FROM quiz_sessions ORDER BY created_at DESC");
    const attempts = await db.query(`
        SELECT a.*, u.fullname, s.title as quiz_title FROM quiz_attempts a 
        JOIN users u ON a.user_id = u.id JOIN quiz_sessions s ON a.session_id = s.id 
        ORDER BY a.finish_time DESC LIMIT 50
    `);
    res.render('admin-quizzes', { user: req.session.user, sessions: sessions.rows, attempts: attempts.rows });
});

app.post('/admin/create-session', isAdmin, async (req, res) => {
    const { title, start_time, end_time, duration } = req.body;
    await db.query("INSERT INTO quiz_sessions (title, start_time, end_time, duration_minutes) VALUES ($1, $2, $3, $4)", [title, start_time, end_time, duration]);
    res.redirect('/admin/quizzes');
});

app.get('/admin/quiz/:id/questions', isAdmin, async (req, res) => {
    const session = await db.query("SELECT * FROM quiz_sessions WHERE id = $1", [req.params.id]);
    const questions = await db.query("SELECT * FROM quizzes WHERE session_id = $1", [req.params.id]);
    res.render('admin-manage-questions', { user: req.session.user, session: session.rows[0], questions: questions.rows });
});

app.post('/admin/quiz/:id/import-text', isAdmin, async (req, res) => {
    try {
        const questionsArray = JSON.parse(req.body.jsonText);
        for (const q of questionsArray) {
            await db.query("INSERT INTO quizzes (session_id, question, option_a, option_b, option_c, option_d, correct_option) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                [req.params.id, q.question, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option.toUpperCase()]);
        }
        res.redirect(`/admin/quiz/${req.params.id}/questions`);
    } catch (err) { res.status(400).send("Invalid JSON"); }
});

function isUser(req, res, next) {
    if (req.session && req.session.user) return next();
    res.redirect('/login');
}

// --- ADMIN: DELETE SESSION ---
app.post('/admin/delete-session/:id', isAdmin, async (req, res) => {
    try {
        const sessionId = req.params.id;
        
        // 1. Delete questions associated with this session first (to avoid Foreign Key errors)
        await db.query("DELETE FROM quizzes WHERE session_id = $1", [sessionId]);
        
        // 2. Delete the session itself
        await db.query("DELETE FROM quiz_sessions WHERE id = $1", [sessionId]);
        
        console.log(`Session ${sessionId} deleted successfully`);
        res.redirect('/admin/quizzes');
    } catch (err) {
        console.error("Delete Session Error:", err.message);
        res.status(500).send("Could not delete session. It might have active attempts linked to it.");
    }
});

// Add this at the end of app.js
app.use((err, req, res, next) => {
  res.status(500).json({
    message: "Alite, the server crashed!",
    error: err.message,
    stack: err.stack
  });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Student Link is running on http://localhost:${PORT}`);
});
