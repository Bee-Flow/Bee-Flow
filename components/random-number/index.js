// Generate Random Number Component
// Generates a random number between min and max values

let inputData = "";
process.stdin.on("data", chunk => { inputData += chunk; });

process.stdin.on("end", () => {
    try {
        const inputs = inputData.trim() ? JSON.parse(inputData) : {};

        // Get min and max, with defaults
        const min = Number(inputs.min) || 0;
        const max = Number(inputs.max) || 100;

        // Validate min < max
        if (min >= max) {
            console.log(JSON.stringify({
                result: null,
                min: min,
                max: max,
                error: "min must be less than max"
            }));
            return;
        }

        // Generate random number
        const result = Math.floor(Math.random() * (max - min + 1)) + min;

        console.log(JSON.stringify({
            result: result,
            min: min,
            max: max
        }));
    } catch (e) {
        console.log(JSON.stringify({
            result: null,
            error: e.message
        }));
    }
});
