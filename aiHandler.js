import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from 'dotenv';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// Get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HISTORIES_DIR = path.join(__dirname, 'histories');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gemini-2.5-flash-lite";
const DEFAULT_MAX_TOKENS = parseInt(process.env.DEFAULT_MAX_TOKENS || '2048', 10);
const DEFAULT_TEMPERATURE = parseFloat(process.env.DEFAULT_TEMPERATURE || '0.7');

// Initialize logger
import { initializeLogger } from './utils/logger.js';
const logger = initializeLogger();

let genAI;
if (GEMINI_API_KEY) {
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
} else {
    logger.error("GEMINI_API_KEY is not set. Please set it in your .env file.");
}

// Function to get the history file path for a mobile number
function getHistoryFilePath(mobileNumber) {
    return path.join(HISTORIES_DIR, `${mobileNumber}.json`);
}

// Function to initialize AI handler for a specific mobile number
export async function initializeAI(logger, mobileNumber) {
    logger.debug(`Initializing AI handler for ${mobileNumber}`);
    await fs.ensureDir(HISTORIES_DIR);

    const handler = {};

    handler.getHistory = async (mobile) => {
        const filePath = getHistoryFilePath(mobile);
        try {
            if (await fs.pathExists(filePath)) {
                const history = await fs.readJson(filePath);
                logger.log('debug', `[AI Handler] History loaded for ${mobile} from ${filePath}`);
                return history;
            }
            return [];
        } catch (error) {
            logger.error(`[AI Handler] Error reading history for ${mobile}: ${error.message}`);
            return []; // Return empty history on error
        }
    };

    handler.addMessageToHistory = async (mobile, role, content) => {
        const filePath = getHistoryFilePath(mobile);
        let history = await handler.getHistory(mobile);

        const lastMessage = history[history.length - 1];
        if (lastMessage && lastMessage.role === role && lastMessage.parts[0].text === content) {
            logger.log('debug', `[AI Handler] Duplicate message detected for ${mobile}. Skipping.`);
            return;
        }

        history.push({ role, parts: [{ text: content }] });

        try {
            await fs.writeJson(filePath, history);
            logger.log('debug', `[AI Handler] History updated for ${mobile} in ${filePath}`);
        } catch (error) {
            logger.error(`[AI Handler] Error writing history for ${mobile}: ${error.message}`);
        }
    };

    handler.clearHistory = async (mobile) => {
        const filePath = getHistoryFilePath(mobile);
        try {
            if (await fs.pathExists(filePath)) {
                await fs.remove(filePath);
                logger.log('debug', `[AI Handler] History cleared for ${mobile}`);
            }
        } catch (error) {
            logger.error(`[AI Handler] Error clearing history for ${mobile}: ${error.message}`);
        }
    };

    return handler;
}

// Function to generate AI response
export async function generateAIResponse(userMessage, mobileNumber, promptManager, aiHandler) {
    if (!GEMINI_API_KEY) {
        throw new Error("Gemini API key is not configured.");
    }

    const logger = initializeLogger(); // Get logger instance

    try {
        // Get the system prompt for this session
        const systemPromptData = promptManager.getPromptByMobile(mobileNumber);
        if (!systemPromptData || !systemPromptData.systemPrompt) {
            logger.error(`System prompt data or content not found for ${mobileNumber}`);
            throw new Error(`System prompt not found or invalid for ${mobileNumber}`);
        }
        const systemPromptText = systemPromptData.systemPrompt;

        // Get current history
        let history = await aiHandler.getHistory(mobileNumber);

        // Add user's message to history before calling the model
        await aiHandler.addMessageToHistory(mobileNumber, 'user', userMessage);
        history = await aiHandler.getHistory(mobileNumber); // Refresh history

        // Select the model and provide the system prompt separately
        const model = genAI.getGenerativeModel({
            model: DEFAULT_MODEL,
            systemInstruction: {
                role: "system",
                parts: [{ text: systemPromptText }],
            },
        });

        logger.info(`Calling Gemini API for ${mobileNumber} with history length ${history.length}`);

        // Start a chat session with the model
        const chat = model.startChat({
            history: history,
            generationConfig: {
                maxOutputTokens: DEFAULT_MAX_TOKENS,
                temperature: DEFAULT_TEMPERATURE,
            },
        });

        const result = await chat.sendMessage(userMessage);
        const response = result.response;
        const text = response.text();

        // Add model's response to history
        await aiHandler.addMessageToHistory(mobileNumber, 'model', text);

        logger.info(`Gemini API response received for ${mobileNumber}`);
        return text;

    } catch (error) {
        logger.error(`Error generating AI response for ${mobileNumber}: ${error.message}`);
        // Rethrow or return an error message
        throw new Error(`Failed to generate AI response: ${error.message}`);
    }
}