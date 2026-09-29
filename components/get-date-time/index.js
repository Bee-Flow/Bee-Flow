const fs = require('fs');
const {
    add, 
    format, 
    parseISO,
    lastDayOfWeek,
    lastDayOfMonth,
    lastDayOfYear
} = require('date-fns');

async function main() {
    try {
        const inputData = fs.readFileSync(0, 'utf-8');
        const inputs = JSON.parse(inputData);

        const { 
            baseDate: baseDateStr, 
            period, 
            amount = 0, 
            unit = 'seconds', 
            format: outputFormat = 'yyyy-MM-dd HH:mm:ss' 
        } = inputs;

        // --- Input Validation ---
        if (baseDateStr && typeof baseDateStr !== 'string') {
            throw new Error(`Invalid input: 'baseDate' must be a string in ISO format (e.g., YYYY-MM-DD).`);
        }
        if (period && !['week', 'month', 'year'].includes(period)) {
            throw new Error(`Invalid input: 'period' must be one of ['week', 'month', 'year'].`);
        }
        // More validations from previous steps...

        // --- Logic ---
        let baseDate;
        if (baseDateStr) {
            baseDate = parseISO(baseDateStr);
            if (isNaN(baseDate.getTime())) {
                throw new Error(`Invalid date format for 'baseDate'. Received: ${baseDateStr}`);
            }
        } else {
            baseDate = new Date();
        }

        let resultDate;

        if (period) {
            switch (period) {
                case 'week':
                    resultDate = lastDayOfWeek(baseDate);
                    break;
                case 'month':
                    resultDate = lastDayOfMonth(baseDate);
                    break;
                case 'year':
                    resultDate = lastDayOfYear(baseDate);
                    break;
            }
        } else if (amount !== 0) {
            resultDate = add(baseDate, { [unit]: amount });
        } else {
            resultDate = baseDate;
        }

        const formattedDate = format(resultDate, outputFormat);

        const output = { datetime: formattedDate };
        console.log(JSON.stringify(output));

    } catch (error) {
        console.log(JSON.stringify({ error: `Component Error: ${error.message}` }));
        process.exit(1);
    }
}

main();
