export function buildCommitMessagePrompt(diffText: string): string {
  return [
    'You generate git commit messages.',
    'Create a single commit message line from the provided diff.',
    '',
    'Strict output rules:',
    '- Output exactly one line.',
    '- Japanese only.',
    '- 30 to 50 characters.',
    '- No markdown.',
    '- No quotes.',
    '- No bullets.',
    '- No prefixes like feat/fix/chore.',
    '- Focus on concrete code changes.',
    '',
    'Return only the final commit message line.',
    '',
    '<diff>',
    diffText,
    '</diff>'
  ].join('\n');
}
