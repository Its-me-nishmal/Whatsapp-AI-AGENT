import Joi from 'joi';
import { initializeLogger } from '../utils/logger.js';

const logger = initializeLogger();

// Schema for validating mobile number
const mobileSchema = Joi.string().pattern(/^\d+$/).required();

// Schema for session creation/update
const sessionSchema = Joi.object({
    // No specific body for POST /mobile/:mobile/session, but could add if needed
});

// Schema for sending messages
export const sendMessageSchema = Joi.object({
    to: Joi.string().pattern(/^\d+@c.us$/).required().messages({
        'string.pattern.base': 'Recipient "to" must be a valid WhatsApp ID (e.g., 1234567890@c.us)',
    }),
    message: Joi.string().min(1).required(),
});

// Schema for prompt management
export const promptSchema = Joi.object({
    systemPrompt: Joi.string().min(1).required(),
});

// Middleware to validate path parameters (e.g., mobile number)
export const validateMobileParam = (req, res, next) => {
    const { error, value } = mobileSchema.validate(req.params.mobile);
    if (error) {
        logger.warn(`Validation error for mobile param: ${error.details[0].message}`);
        return res.status(400).json({ message: error.details[0].message });
    }
    // Optionally, attach validated mobile number to request
    req.params.mobile = value; // Use the validated value
    next();
};

// Middleware to validate request body for specific routes
export const validateRequestBody = (schema) => {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.body);
        if (error) {
            logger.log('warn', `Validation error for request body: ${error.details[0].message}`);
            return res.status(400).json({ message: error.details[0].message });
        }
        // Replace req.body with the validated value
        req.body = value;
        next();
    };
};

// Function to set up all validation middleware for the app
export const setupValidation = (app) => {
    // This function primarily exports the schemas and validators for use in route definitions.
    // Direct application to routes is done in app.js.
    logger.info('Validation middleware setup complete. Schemas exported.');
    return {
        mobileSchema,
        sessionSchema,
        sendMessageSchema,
        promptSchema,
        validateMobileParam,
        validateRequestBody
    };
};