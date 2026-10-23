/**
 * Test Pinecone metadata filtering for clinical-note vector search.
 *
 * Runs a query without a filter and again with age >= 65.
 * Saves each run's output to a separate numbered file inside output/metadata-filter-tests/.
 */

import 'dotenv/config';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { searchClinicalNotes } from '../lib/vector-search';

async function main() {
    const output: string[] = [];

    function log(message: string) {
        console.log(message);
        output.push(message);
    }

    try {
        const query = 'What symptoms were reported?';

        log('=== Search WITHOUT a filter ===');

        const unfilteredResults = await searchClinicalNotes(query);
        log(unfilteredResults);

        log('\n=== Search WITH filter ===');

        const filteredResults = await searchClinicalNotes(query, {
            filter: {
                age: { $lt: 65 },
                gender: { $eq: 'female' },
            },
        });
        console.log('FILTER BEING TESTED:', {
            age: { $lt: 65 },
            gender: { $eq: 'female' },
        });
        log(filteredResults);

        log('\n=== Test complete ===');
        log(
            'Compare the results above to check whether the age filter changes the returned notes.',
        );
    } catch (error) {
        const message =
            error instanceof Error
                ? error.stack ?? error.message
                : String(error);

        log(`\n=== TEST FAILED ===\n${message}`);
        process.exitCode = 1;
    } finally {
        // Create the output folder if it does not already exist.
        const outputDir = resolve(
            process.cwd(),
            'output',
            'metadata-filter-tests',
        );
        mkdirSync(outputDir, { recursive: true });

        // Find the next available numbered filename.
        let fileNumber = 1;
        let outputPath = resolve(outputDir, `results-${fileNumber}.txt`);

        while (existsSync(outputPath)) {
            fileNumber++;
            outputPath = resolve(outputDir, `results-${fileNumber}.txt`);
        }

        // Save this run without overwriting previous results.
        writeFileSync(outputPath, output.join('\n'), 'utf8');

        console.log(`\nFull test output saved to: ${outputPath}`);
    }
}

main();