import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra'; // For directory creation

// Import managers and utilities
import { initializeLogger } from './utils/logger.js';
import { initializeSessionManager } from './sessionManager.js';
import { initializePromptManager } from './promptManager.js';
import { setupValidation, validateMobileParam, validateRequestBody, sendMessageSchema, promptSchema } from './middleware/validation.js';

// Load environment variables
dotenv.config();

// Get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize logger
const logger = initializeLogger();

// Ensure necessary directories exist
const sessionsDir = path.join(__dirname, 'sessions');
const promptsDir = path.join(__dirname, 'prompts');
const logsDir = path.join(__dirname, 'logs');
const historiesDir = path.join(__dirname, 'histories');


try {
    fs.ensureDirSync(sessionsDir);
    logger.info(`Sessions directory ensured at: ${sessionsDir}`);
    fs.ensureDirSync(promptsDir); // Ensure prompts directory exists too
    logger.info(`Prompts directory ensured at: ${promptsDir}`);
    fs.ensureDirSync(logsDir); // Ensure logs directory exists
    logger.info(`Logs directory ensured at: ${logsDir}`);
    fs.ensureDirSync(historiesDir); // Ensure histories directory exists
    logger.info(`Histories directory ensured at: ${historiesDir}`);
} catch (err) {
    logger.error(`Failed to ensure directories: ${err.message}`);
    // In a real app, you might want to handle this more gracefully or exit
    process.exit(1);
}

// Initialize managers
// Pass necessary configurations and logger to managers
const promptManager = initializePromptManager(logger, __dirname);
const sessionManager = initializeSessionManager(logger, __dirname, promptManager); // Pass promptManager if needed by sessionManager

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' })); // Increased limit for potential large messages or payloads
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files

// Setup validation middleware (e.g., Joi)
// This should be done before routes that require validation
setupValidation(app); // Apply validation middleware

// --- Routes ---

// Health Check
app.get('/health', (req, res) => {
    res.status(200).json({ message: 'WhatsApp AI Bot is running!' });
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Session Management Routes
// POST /mobile/:mobile/session - Create or reuse session
app.post('/mobile/:mobile/session', validateMobileParam, (req, res) => {
    sessionManager.createOrReuseSession(req, res);
});

// GET /mobile/:mobile/status - Get session status
app.get('/mobile/:mobile/status', validateMobileParam, (req, res) => {
    sessionManager.getSessionStatus(req, res);
});

// GET /mobile/:mobile/pairing-code - Get last pairing code
app.get('/mobile/:mobile/pairing-code', validateMobileParam, (req, res) => {
    sessionManager.getPairingCode(req, res);
});

// POST /mobile/:mobile/send - Send message
app.post('/mobile/:mobile/send', validateMobileParam, validateRequestBody(sendMessageSchema), (req, res) => {
    sessionManager.sendMessage(req, res);
});

// GET /mobiles - List all active mobile sessions
app.get('/mobiles', (req, res) => {
    sessionManager.listSessions(req, res);
});

// DELETE /mobile/:mobile/session - Destroy session
app.delete('/mobile/:mobile/session', validateMobileParam, (req, res) => {
    sessionManager.deleteSession(req, res);
});

// Prompt Management Routes
// GET /mobile/:mobile/prompt - Get prompt for a mobile number
app.get('/mobile/:mobile/prompt', validateMobileParam, promptManager.getPrompt);

// POST /mobile/:mobile/prompt - Set/update prompt for a mobile number
app.post('/mobile/:mobile/prompt', validateMobileParam, validateRequestBody(promptSchema), (req, res) => {
    promptManager.setPrompt(req, res);
});

// DELETE /mobile/:mobile/prompt - Remove custom prompt for a mobile number
app.delete('/mobile/:mobile/prompt', validateMobileParam, (req, res) => {
    promptManager.deletePrompt(req, res);
});

// --- Error Handling Middleware ---
// This should be the last middleware added
app.use((err, req, res, next) => {
    // Log the error with winston
    logger.error(`${err.statusCode || 500} - ${err.message} - ${req.originalUrl} - ${req.method} - ${req.ip}`);

    // Send a JSON error response
    res.status(err.status || 500).json({ // Use err.status if available, otherwise 500
        message: err.message || 'Internal Server Error',
        // Include stack trace only in development for debugging
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
});

// Start the server
app.listen(PORT, () => {
    logger.info(`Server is running on port ${PORT}`);
    // Load existing sessions on startup
    sessionManager.loadExistingSessions();
});

export default app; // Export for potential testing or other uses