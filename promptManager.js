import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeLogger } from './utils/logger.js';

// Get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = initializeLogger();

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const DEFAULT_PROMPT_FILE = path.join(PROMPTS_DIR, 'default.json');

// In-memory store for prompts
// Map<mobileNumber, { systemPrompt: string }>
const customPrompts = new Map();
let defaultPrompt = null;

// Ensure prompts directory and default prompt file exist
async function ensurePromptFiles() {
    try {
        await fs.ensureDir(PROMPTS_DIR);
        logger.info(`Prompts directory ensured at: ${PROMPTS_DIR}`);

        if (!await fs.pathExists(DEFAULT_PROMPT_FILE)) {
            logger.warn(`Default prompt file not found at ${DEFAULT_PROMPT_FILE}. Creating a default one.`);
            const defaultContent = {
                systemPrompt: "You are a helpful AI assistant integrated with WhatsApp. Respond to user messages conversationally and provide assistance. Keep responses concise and relevant to the conversation. You can access information and perform tasks based on the context provided."
            };
            await fs.writeJson(DEFAULT_PROMPT_FILE, defaultContent);
            logger.info(`Default prompt file created at ${DEFAULT_PROMPT_FILE}`);
        }
    } catch (error) {
        logger.error(`Error ensuring prompt files: ${error.message}`);
        throw error; // Propagate error
    }
}

// Load default prompt
async function loadDefaultPrompt() {
    try {
        await ensurePromptFiles(); // Ensure files exist before reading
        const data = await fs.readJson(DEFAULT_PROMPT_FILE);
        defaultPrompt = data;
        logger.info('Default prompt loaded successfully.');
    } catch (error) {
        logger.error(`Failed to load default prompt: ${error.message}`);
        defaultPrompt = { systemPrompt: "Error loading default prompt." }; // Fallback
    }
}

// Load custom prompts from files on startup (or when needed)
async function loadCustomPrompts() {
    try {
        await ensurePromptFiles(); // Ensure directory exists
        const files = await fs.readdir(PROMPTS_DIR);
        for (const file of files) {
            if (file.endsWith('.json') && file !== 'default.json') {
                const mobileNumber = file.replace('.json', '');
                const filePath = path.join(PROMPTS_DIR, file);
                try {
                    const data = await fs.readJson(filePath);
                    customPrompts.set(mobileNumber, data);
                    logger.log('debug', `Loaded custom prompt for ${mobileNumber}`);
                } catch (error) {
                    logger.error(`Failed to load custom prompt for ${mobileNumber} from ${file}: ${error.message}`);
                }
            }
        }
        logger.info(`Loaded ${customPrompts.size} custom prompts.`);
    } catch (error) {
        logger.error(`Error loading custom prompts: ${error.message}`);
    }
}

// Initialize prompt manager
export function initializePromptManager(logger, __dirname) {
    // Load prompts on initialization
    loadDefaultPrompt().catch(err => logger.error("Initial default prompt load failed.", err));
    loadCustomPrompts().catch(err => logger.error("Initial custom prompts load failed.", err));

    // Internal function to get prompt by mobile number
    const getPromptByMobile = (mobile) => {
        const mobileNumber = mobile.replace(/\D/g, ''); // Ensure digits only
        const prompt = customPrompts.get(mobileNumber) || defaultPrompt;
        if (!prompt) {
            logger.error(`No prompt found for ${mobileNumber} and default prompt is also missing.`);
            throw new Error('Prompt not found.');
        }
        return prompt;
    };

    // API handler for GET /mobile/:mobile/prompt
    const getPrompt = async (req, res) => {
        const { mobile } = req.params;
        try {
            const prompt = getPromptByMobile(mobile);
            res.status(200).json(prompt);
        } catch (error) {
            logger.error(`Error in getPrompt for ${mobile}: ${error.message}`);
            res.status(404).json({ message: error.message });
        }
    };

    // POST /mobile/:mobile/prompt
    const setPrompt = async (req, res) => {
        const { mobile } = req.params;
        const mobileNumber = mobile.replace(/\D/g, '');
        const { systemPrompt } = req.body;

        if (!systemPrompt) {
            return res.status(400).json({ message: 'Missing "systemPrompt" in request body.' });
        }

        const promptData = { systemPrompt };
        const filePath = path.join(PROMPTS_DIR, `${mobileNumber}.json`);

        try {
            await fs.writeJson(filePath, promptData);
            customPrompts.set(mobileNumber, promptData);
            logger.info(`Custom prompt set for ${mobileNumber}`);
            if (res) { // Check if res is provided (for API calls)
                res.status(200).json({ message: `Prompt updated for ${mobileNumber}`, prompt: promptData });
            }
        } catch (error) {
            logger.error(`Failed to set prompt for ${mobileNumber}: ${error.message}`);
            if (res) { // Check if res is provided
                res.status(500).json({ message: 'Failed to set prompt', error: error.message });
            }
        }
    };

    // DELETE /mobile/:mobile/prompt
    const deletePrompt = async (req, res) => {
        const { mobile } = req.params;
        const mobileNumber = mobile.replace(/\D/g, '');
        const filePath = path.join(PROMPTS_DIR, `${mobileNumber}.json`);

        if (customPrompts.has(mobileNumber)) {
            try {
                await fs.remove(filePath);
                customPrompts.delete(mobileNumber);
                logger.info(`Custom prompt deleted for ${mobileNumber}`);
                res.status(200).json({ message: `Custom prompt removed for ${mobileNumber}. Reverted to default.` });
            } catch (error) {
                logger.error(`Failed to delete custom prompt for ${mobileNumber}: ${error.message}`);
                res.status(500).json({ message: 'Failed to delete prompt', error: error.message });
            }
        } else {
            res.status(404).json({ message: 'No custom prompt found for this mobile number.' });
        }
    };

    // GET /prompts
    const listPrompts = async (req, res) => {
        const allPrompts = {
            default: defaultPrompt,
            custom: {},
        };

        for (const [mobile, prompt] of customPrompts.entries()) {
            allPrompts.custom[mobile] = prompt;
        }

        res.status(200).json(allPrompts);
    };

    // Return the public API of the prompt manager
    return {
        initializePromptManager,
        getPrompt, // Route handler
        getPromptByMobile, // Internal function
        setPrompt,
        deletePrompt,
        listPrompts,
        ensurePromptFiles,
        loadDefaultPrompt,
        loadCustomPrompts,
    };
}