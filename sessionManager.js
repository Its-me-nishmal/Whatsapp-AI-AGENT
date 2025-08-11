import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeLogger } from './utils/logger.js';
import { initializePromptManager } from './promptManager.js';
import { initializeAI, generateAIResponse } from './aiHandler.js';

// Get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = initializeLogger();

// Configuration from environment variables or defaults
const SESSION_TIMEOUT = parseInt(process.env.SESSION_TIMEOUT || '3600000', 10); // 1 hour in ms
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '10', 10);
const SESSIONS_DIR = path.join(__dirname, 'sessions');

// In-memory store for clients and their states
const clients = new Map(); // Map<mobileNumber, { client: Client, status: string, pairingCode: string | null, lastActive: number, promptManager: any, aiHandler: any }>

// Ensure sessions directory exists
fs.ensureDirSync(SESSIONS_DIR);

export function initializeSessionManager(logger, __dirname, promptManager) {
    const SESSIONS_DIR = path.join(__dirname, 'sessions');
    fs.ensureDirSync(SESSIONS_DIR);

    // Function to get client by mobile number
    const getClient = (mobile) => clients.get(mobile)?.client;

    // Function to get session state by mobile number
    const getSessionState = (mobile) => clients.get(mobile);

    // Function to update session state
    const updateSessionState = (mobile, state) => {
        if (clients.has(mobile)) {
            clients.set(mobile, { ...clients.get(mobile), ...state });
        } else {
            clients.set(mobile, state);
        }
    };

    // Function to remove session
    const removeSession = async (mobile) => {
        const sessionState = clients.get(mobile);
        if (sessionState && sessionState.client) {
            try {
                await sessionState.client.destroy();
                logger.info(`Client destroyed for ${mobile}`);
            } catch (error) {
                logger.error(`Error destroying client for ${mobile}: ${error.message}`);
            }
        }
        // Clear session data file
        const sessionPath = path.join(SESSIONS_DIR, `session-${mobile}`);
        try {
            await fs.remove(sessionPath);
            logger.info(`Session data removed for ${mobile} at ${sessionPath}`);
        } catch (error) {
            logger.error(`Error removing session data for ${mobile}: ${error.message}`);
        }
        // Clear AI history (assuming aiHandler has a clearHistory method)
        if (sessionState && sessionState.aiHandler) {
            try {
                await sessionState.aiHandler.clearHistory(mobile);
                logger.info(`AI history cleared for ${mobile}`);
            } catch (error) {
                logger.error(`Error clearing AI history for ${mobile}: ${error.message}`);
            }
        }
        clients.delete(mobile);
        logger.info(`Session state removed from memory for ${mobile}`);
    };

    // Function to load existing sessions on startup
    const loadExistingSessions = async () => {
        logger.info('Loading existing sessions...');
        try {
            const sessionFolders = await fs.readdir(SESSIONS_DIR);
            for (const folder of sessionFolders) {
                if (folder.startsWith('session-')) {
                    const mobileNumber = folder.replace('session-', '');
                    logger.info(`Found session for ${mobileNumber}. Attempting to initialize...`);
                    try {
                        // Re-initialize client with existing session data
                        const client = new Client({
                            authStrategy: new LocalAuth({ clientId: mobileNumber, dataPath: SESSIONS_DIR }),
                            puppeteer: {
                                headless: true,
                                args: [
                                    '--no-sandbox',
                                    '--disable-setuid-sandbox',
                                    '--disable-dev-shm-usage',
                                    '--disable-gpu'
                                ],
                            },
                        });

                        client.on('qr', async (qr) => {
                            logger.warn(`QR generated for existing session ${mobileNumber}. Attempting to get pairing code instead.`);
                            try {
                                const pairingCode = await client.requestPairingCode(mobileNumber);
                                logger.info(`Pairing code for ${mobileNumber}: ${pairingCode}`);
                                updateSessionState(mobileNumber, { status: 'pairing', pairingCode });
                            } catch (e) {
                                logger.error(`Could not get pairing code for ${mobileNumber}. QR was: ${qr}`);
                                updateSessionState(mobileNumber, { status: 'pairing', pairingCode: 'ERROR' });
                            }
                        });

                        client.on('ready', () => {
                            logger.info(`Session ready for ${mobileNumber}`);
                            updateSessionState(mobileNumber, { client, status: 'ready', pairingCode: null, lastActive: Date.now() });
                        });

                        client.on('authenticated', () => {
                            logger.info(`Session authenticated for ${mobileNumber}`);
                            updateSessionState(mobileNumber, { client, status: 'authenticated', lastActive: Date.now() });
                        });

                        client.on('auth_failure', (msg) => {
                            logger.error(`Authentication failure for ${mobileNumber}: ${msg}`);
                            updateSessionState(mobileNumber, { client, status: 'unauthenticated', pairingCode: null, lastActive: Date.now() });
                            // Optionally remove the session if auth fails repeatedly
                            // removeSession(mobileNumber);
                        });

                        client.on('disconnected', (reason) => {
                            logger.warn(`Session disconnected for ${mobileNumber}: ${reason}`);
                            updateSessionState(mobileNumber, { client, status: 'disconnected', pairingCode: null, lastActive: Date.now() });
                            // Optionally attempt to reconnect or remove session
                            // if (reason !== 'NAVIGATION') { // Avoid removing if it's just a navigation event
                            //     removeSession(mobileNumber);
                            // }
                        });

                        client.on('message_create', async (msg) => {

                            logger.info(`Received message for ${mobileNumber}: ${msg.body}`);
                            if (msg.body && msg.body.startsWith('.')) {
                                logger.info(`Received command from ${msg.from}: ${msg.body}`);
                                const fromNumber = msg.from.split('@')[0];
                                const sessionOwnerNumber = client.info.wid.user;
                        
                                const command = msg.body.slice(1).trim();
                                const [commandName, ...args] = command.split(' ');
                        
                                if (commandName === 'setprompt' && fromNumber === sessionOwnerNumber) {
                                    const newPrompt = args.join(' ');
                                    if (newPrompt) {
                                        try {
                                            await promptManager.setPrompt({ params: { mobile: sessionOwnerNumber }, body: { systemPrompt: newPrompt } });
                                            await client.sendMessage(msg.from, 'Prompt updated successfully!');
                                            logger.info(`Prompt updated by admin ${sessionOwnerNumber}`);
                                        } catch (error) {
                                            logger.error(`Error setting prompt: ${error.message}`);
                                            await client.sendMessage(msg.from, 'Failed to update prompt.');
                                        }
                                    } else {
                                        await client.sendMessage(msg.from, 'Please provide a prompt after the .setprompt command.');
                                    }
                                } else if (command.length > 0) {
                                    try {
                                        const aiHandler = await initializeAI(logger, fromNumber);
                                        const response = await generateAIResponse(
                                            command,
                                            fromNumber,
                                            promptManager,
                                            aiHandler
                                        );
                                        if (response) {
                                            await client.sendMessage(msg.from, response);
                                            logger.info(`Sent AI response to ${msg.from}`);
                                        }
                                    } catch (error) {
                                        logger.error(`Error processing message from ${msg.from}: ${error.message}`);
                                        await client.sendMessage(msg.from, 'Sorry, I encountered an error processing your request.');
                                    }
                                } else {
                                    await client.sendMessage(msg.from, 'Welcome! You can start a conversation by sending a message starting with a dot (.), or set a new prompt using ".setprompt your new prompt here".');
                                }
                            }
                        });

                        await client.initialize();
                        logger.info(`Client initialization started for ${mobileNumber}`);
                        updateSessionState(mobileNumber, { client, status: 'initializing', pairingCode: null, lastActive: Date.now(), promptManager: promptManager, aiHandler: null }); // AI handler will be initialized on first message
                    } catch (error) {
                        logger.error(`Failed to initialize session for ${mobileNumber}: ${error.message}`);
                        // Clean up potentially corrupted session data
                        await removeSession(mobileNumber);
                    }
                }
            }
            logger.info('Finished loading existing sessions.');
        } catch (error) {
            logger.error(`Error reading session directories: ${error.message}`);
        }
    };

    // --- API Route Handlers ---

    // POST /mobile/:mobile/session
    const createOrReuseSession = async (req, res) => {
        const { mobile } = req.params;
        const mobileNumber = mobile.replace(/\D/g, ''); // Ensure digits only

        if (clients.size >= MAX_SESSIONS && !clients.has(mobileNumber)) {
            return res.status(429).json({ message: 'Maximum number of sessions reached.' });
        }

        const sessionState = getSessionState(mobileNumber);

        if (sessionState && sessionState.client && (sessionState.status === 'ready' || sessionState.status === 'authenticated')) {
            logger.info(`Session already exists and is ${sessionState.status} for ${mobileNumber}`);
            updateSessionState(mobileNumber, { lastActive: Date.now() }); // Update last active time
            return res.status(200).json({ message: `Session already active with status: ${sessionState.status}`, exists: true, ready: true, pairingCode: null });
        }

        if (sessionState && sessionState.client && sessionState.status === 'pairing') {
            logger.info(`Session for ${mobileNumber} is in pairing state.`);
            return res.status(200).json({ message: 'Session is pairing', exists: true, ready: false, pairingCode: sessionState.pairingCode });
        }

        if (sessionState && sessionState.status === 'initializing') {
            logger.info(`Session for ${mobileNumber} is currently initializing. Please wait.`);
            return res.status(200).json({ message: 'Session is currently initializing, please wait.', exists: true, ready: false, pairingCode: null });
        }

        logger.info(`Creating new session for ${mobileNumber}. Bot is working...`);

        try {
            const client = new Client({
                authStrategy: new LocalAuth({ clientId: mobileNumber, dataPath: SESSIONS_DIR }),
                puppeteer: {
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu'
                    ],
                },
            });


            client.on('ready', () => {
                logger.info(`Session ready for ${mobileNumber}`);
                updateSessionState(mobileNumber, { client, status: 'ready', pairingCode: null, lastActive: Date.now() });
            });

            client.on('authenticated', () => {
                logger.info(`Session authenticated for ${mobileNumber}`);
                updateSessionState(mobileNumber, { client, status: 'authenticated', lastActive: Date.now() });
            });

            client.on('auth_failure', (msg) => {
                logger.error(`Authentication failure for ${mobileNumber}: ${msg}`);
                updateSessionState(mobileNumber, { client, status: 'unauthenticated', pairingCode: null, lastActive: Date.now() });
                // Consider removing session on auth failure
                // removeSession(mobileNumber);
            });

            client.on('disconnected', (reason) => {
                logger.warn(`Session disconnected for ${mobileNumber}: ${reason}`);
                updateSessionState(mobileNumber, { client, status: 'disconnected', pairingCode: null, lastActive: Date.now() });
                // Consider removing session on disconnect if not a navigation event
                // if (reason !== 'NAVIGATION') {
                //     removeSession(mobileNumber);
                // }
            });

            client.on('message_create', async (msg) => {

                            logger.info(`Received message for ${mobileNumber}: ${msg.body}`);
                            if (msg.body && msg.body.startsWith('.')) {
                                logger.info(`Received command from ${msg.from}: ${msg.body}`);
                                const fromNumber = msg.from.split('@')[0];
                                const sessionOwnerNumber = client.info.wid.user;
                        
                                const command = msg.body.slice(1).trim();
                                const [commandName, ...args] = command.split(' ');
                        
                                if (commandName === 'setprompt' && fromNumber === sessionOwnerNumber) {
                                    const newPrompt = args.join(' ');
                                    if (newPrompt) {
                                        try {
                                            await promptManager.setPrompt({ params: { mobile: sessionOwnerNumber }, body: { systemPrompt: newPrompt } });
                                            await client.sendMessage(msg.from, 'Prompt updated successfully!');
                                            logger.info(`Prompt updated by admin ${sessionOwnerNumber}`);
                                        } catch (error) {
                                            logger.error(`Error setting prompt: ${error.message}`);
                                            await client.sendMessage(msg.from, 'Failed to update prompt.');
                                        }
                                    } else {
                                        await client.sendMessage(msg.from, 'Please provide a prompt after the .setprompt command.');
                                    }
                                } else if (command.length > 0) {
                                    try {
                                        const aiHandler = await initializeAI(logger, fromNumber);
                                        const response = await generateAIResponse(
                                            command,
                                            fromNumber,
                                            promptManager,
                                            aiHandler
                                        );
                                        if (response) {
                                            await client.sendMessage(msg.from, response);
                                            logger.info(`Sent AI response to ${msg.from}`);
                                        }
                                    } catch (error) {
                                        logger.error(`Error processing message from ${msg.from}: ${error.message}`);
                                        await client.sendMessage(msg.from, 'Sorry, I encountered an error processing your request.');
                                    }
                                } else {
                                    await client.sendMessage(msg.from, 'Welcome! You can start a conversation by sending a message starting with a dot (.), or set a new prompt using ".setprompt your new prompt here".');
                                }
                            }
                        });

            await client.initialize();
            logger.info(`Client initialization started for ${mobileNumber}`);
            updateSessionState(mobileNumber, { client, status: 'initializing', pairingCode: null, lastActive: Date.now(), promptManager: promptManager, aiHandler: null }); // AI handler initialized on first message

            const pairingCode = await client.requestPairingCode(mobileNumber);
            logger.info(`Pairing code for ${mobileNumber}: ${pairingCode}`);
            updateSessionState(mobileNumber, { status: 'pairing', pairingCode });

            res.status(201).json({ message: 'Session initialization started. Use pairing code.', exists: true, ready: false, pairingCode });

        } catch (error) {
            logger.error(`Failed to initialize session for ${mobileNumber}: ${error.message}`);
            // Clean up potentially corrupted session data
            await removeSession(mobileNumber);
            res.status(500).json({ message: 'Failed to initialize session', error: error.message });
        }
    };

    // GET /mobile/:mobile/status
    const getSessionStatus = (req, res) => {
        const { mobile } = req.params;
        const mobileNumber = mobile.replace(/\D/g, '');

        const sessionState = getSessionState(mobileNumber);

        if (!sessionState) {
            return res.status(404).json({ message: 'Session not found', exists: false, ready: false, pairingCode: null });
        }

        res.status(200).json({
            exists: true,
            ready: sessionState.status === 'ready',
            pairingCode: sessionState.status === 'pairing' ? sessionState.pairingCode : null,
            status: sessionState.status,
        });
    };

    // GET /mobile/:mobile/pairing-code
    const getPairingCode = (req, res) => {
        const { mobile } = req.params;
        const mobileNumber = mobile.replace(/\D/g, '');

        const sessionState = getSessionState(mobileNumber);

        if (!sessionState || sessionState.status !== 'pairing' || !sessionState.pairingCode) {
            return res.status(404).json({ message: 'No active pairing code found for this session.' });
        }

        res.status(200).json({ pairingCode: sessionState.pairingCode });
    };

    // POST /mobile/:mobile/send
    const sendMessage = async (req, res) => {
        const { mobile } = req.params;
        const mobileNumber = mobile.replace(/\D/g, '');
        const { to, message } = req.body;

        if (!to || !message) {
            return res.status(400).json({ message: 'Missing "to" or "message" in request body.' });
        }

        const sessionState = getSessionState(mobileNumber);

        if (!sessionState || !sessionState.client || sessionState.status !== 'ready') {
            return res.status(404).json({ message: 'Session not found or not ready.' });
        }

        try {
            await sessionState.client.sendMessage(to, message);
            logger.info(`Message sent to ${to} via session ${mobileNumber}`);
            res.status(200).json({ message: 'Message sent successfully' });
        } catch (error) {
            logger.error(`Failed to send message to ${to} via session ${mobileNumber}: ${error.message}`);
            res.status(500).json({ message: 'Failed to send message', error: error.message });
        }
    };

    // GET /mobiles
    const listSessions = (req, res) => {
        const activeSessions = [];
        for (const [mobile, state] of clients.entries()) {
            activeSessions.push({
                mobile: mobile,
                status: state.status,
                ready: state.status === 'ready',
                pairingCode: state.status === 'pairing' ? state.pairingCode : null,
                lastActive: state.lastActive,
            });
        }
        res.status(200).json(activeSessions);
    };

    // DELETE /mobile/:mobile/session
    const deleteSession = async (req, res) => {
        const { mobile } = req.params;
        const mobileNumber = mobile.replace(/\D/g, '');

        const sessionState = getSessionState(mobileNumber);

        if (!sessionState) {
            return res.status(404).json({ message: 'Session not found.' });
        }

        try {
            await removeSession(mobileNumber);
            res.status(200).json({ message: `Session for ${mobileNumber} destroyed successfully.` });
        } catch (error) {
            logger.error(`Failed to delete session for ${mobileNumber}: ${error.message}`);
            res.status(500).json({ message: 'Failed to destroy session', error: error.message });
        }
    };

    // --- Initialization ---
    // Load existing sessions when the manager is initialized
    loadExistingSessions();

    // Return the public API of the session manager
    return {
        getClient,
        getSessionState,
        updateSessionState,
        removeSession,
        loadExistingSessions,
        createOrReuseSession,
        getSessionStatus,
        getPairingCode,
        sendMessage,
        listSessions,
        deleteSession,
    };
}

