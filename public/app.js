document.addEventListener('DOMContentLoaded', () => {
    const mobileNumberInput = document.getElementById('mobileNumber');
    const generateCodeBtn = document.getElementById('generateCodeBtn');
    const sessionInfoDiv = document.getElementById('sessionInfo');
    const statusSpan = document.getElementById('status');
    const pairingCodeSpan = document.getElementById('pairingCode');
    const promptContainer = document.getElementById('promptContainer');
    const promptText = document.getElementById('promptText');
    const savePromptBtn = document.getElementById('savePromptBtn');
    const clearSessionBtn = document.getElementById('clearSessionBtn');
    let statusInterval;

    // Load mobile number from local storage
    const savedMobile = localStorage.getItem('whatsappBotMobile');
    if (savedMobile) {
        mobileNumberInput.value = savedMobile;
        mobileNumberInput.disabled = true;
        generateCodeBtn.disabled = true;
        checkSessionStatus(savedMobile);
    }

    generateCodeBtn.addEventListener('click', async () => {
        const mobile = mobileNumberInput.value.trim();
        if (!mobile) {
            alert('Please enter a mobile number.');
            return;
        }
        localStorage.setItem('whatsappBotMobile', mobile);
        mobileNumberInput.disabled = true;
        generateCodeBtn.disabled = true;
        
        try {
            const response = await fetch(`/mobile/${mobile}/session`, { method: 'POST' });
            const data = await response.json();
            
            statusSpan.textContent = 'Generating...';
            sessionInfoDiv.classList.remove('hidden');

            if (statusInterval) clearInterval(statusInterval);
            statusInterval = setInterval(() => checkSessionStatus(mobile), 2000);

        } catch (error) {
            console.error('Error generating code:', error);
            statusSpan.textContent = 'Error';
            mobileNumberInput.disabled = false;
            generateCodeBtn.disabled = false;
        }
    });

    savePromptBtn.addEventListener('click', async () => {
        const mobile = localStorage.getItem('whatsappBotMobile');
        const systemPrompt = promptText.value.trim();
        if (!mobile || !systemPrompt) {
            alert('No mobile number or prompt to save.');
            return;
        }

        try {
            const response = await fetch(`/mobile/${mobile}/prompt`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ systemPrompt })
            });
            if (response.ok) {
                alert('Prompt saved successfully!');
            } else {
                alert('Failed to save prompt.');
            }
        } catch (error) {
            console.error('Error saving prompt:', error);
            alert('An error occurred while saving the prompt.');
        }
    });

    clearSessionBtn.addEventListener('click', async () => {
        const mobile = localStorage.getItem('whatsappBotMobile');
        if (!mobile) {
            alert('No session to clear.');
            return;
        }

        if (confirm('Are you sure you want to clear this session? This will stop the bot.')) {
            try {
                const response = await fetch(`/mobile/${mobile}/session`, { method: 'DELETE' });
                if (response.ok) {
                    alert('Session cleared successfully.');
                    localStorage.removeItem('whatsappBotMobile');
                    sessionInfoDiv.classList.add('hidden');
                    promptContainer.classList.add('hidden');
                    mobileNumberInput.value = '';
                    mobileNumberInput.disabled = false;
                    generateCodeBtn.disabled = false;
                    if (statusInterval) clearInterval(statusInterval);
                } else {
                    alert('Failed to clear session.');
                }
            } catch (error) {
                console.error('Error clearing session:', error);
                alert('An error occurred while clearing the session.');
            }
        }
    });

    async function checkSessionStatus(mobile) {
        try {
            const response = await fetch(`/mobile/${mobile}/status`);
            const data = await response.json();

            if (data.exists) {
                statusSpan.textContent = data.status;
                pairingCodeSpan.textContent = data.pairingCode || 'N/A';
                sessionInfoDiv.classList.remove('hidden');

                if (data.ready) {
                    pairingCodeSpan.textContent = 'Connected';
                    promptContainer.classList.remove('hidden');
                    if (statusInterval) clearInterval(statusInterval);
                    fetchPrompt(mobile);
                } else if (data.status === 'pairing') {
                    promptContainer.classList.add('hidden');
                }
            } else {
                statusSpan.textContent = 'Not found';
                pairingCodeSpan.textContent = 'N/A';
                if (statusInterval) clearInterval(statusInterval);
            }
        } catch (error) {
            console.error('Error checking status:', error);
            statusSpan.textContent = 'Error';
        }
    }

    async function fetchPrompt(mobile) {
        try {
            const response = await fetch(`/mobile/${mobile}/prompt`);
            const data = await response.json();
            if (response.ok) {
                promptText.value = data.systemPrompt;
            }
        } catch (error) {
            console.error('Error fetching prompt:', error);
        }
    }
});