import assert from "node:assert/strict";
import { test } from "node:test";
import { defeatsAutoPermit, isSafePipeline, matchesAutoPermitted } from "../auto-reviewer.ts";

function autoPermitted(command: string): boolean {
    return (!defeatsAutoPermit(command) && matchesAutoPermitted(command)) || isSafePipeline(command);
}

const needsReview = [
    "echo hello | grep -q missing || echo OR_RAN",
    "echo hello | head -n 1\necho NEWLINE_RAN",
    "which missing || echo OR_RAN", "ls\necho NEWLINE_RAN", "ls\recho CR_RAN",
    "ls &", "ls&", "ls & echo later", "ls && echo later", "ls; echo later",
    "echo hello |& head", "echo hello | head &", "echo hello || head",
    "echo $(whoami)", "echo `whoami`", "echo <(whoami)", "echo $COMMAND",
    "echo hello > out", "echo hello >> out", "echo hello 2> err",
    "echo hello > /dev/null.backup", "echo hello >/dev/null$SUFFIX",
    "echo hello > /dev/null/../out", "echo hello 2>&1out", "echo hello 2>&10",
    "echo hello 3>&1", "echo hello 1>&3", "echo hello 0>&-", "echo hello >&out",
    "echo hello > /dev/null | head > out", "echo hello <<EOF", "echo hello <>file",
    "env echo ENV_RAN", "env -S 'echo ENV_RAN'", "env --split-string='echo ENV_RAN'",
    "echo hello | env echo ENV_RAN", "echo hello | env sh -c 'echo ENV_RAN'",
    "find . -exec echo EXEC_RAN {} +", "find . -execdir echo EXEC_RAN {} +",
    "find . -delete", "find . -fprint printed.txt", "find . -fprintf printed.txt '%p'",
    "find . -fls printed.txt", "find . -ok echo EXEC_RAN {} +",
    "find . -ex\"ec\" echo EXEC_RAN {} +", "find . -name '*.ts' | sort -o out",
    "sort -o out in", "sort -oout in", "sort --output=out in", "sort --out=out in",
    "sort -roout in", "sort -S32K --compress-program=./evil.sh in",
    "sort --compress-program ./evil.sh in", "sort --random-source=./source in",
    "uniq in out", "uniq -- in out", "uniq -c in out", "uniq -f 1 in out",
    "echo hello | uniq in out", "./script --help", "ls-other-command",
    "git branch new-branch", "git tag new-tag", "git remote add name url",
    "git log --output=out", "git log --out=out", "rg --pre ./script pattern",
    "tree -o out", "file -C", "date --set=tomorrow", "hostname new-name",
    "echo hello | head || sh script.sh", "echo hello | head\nsh script.sh",
    "ls \\nsh script.sh", "echo hello # ignored | head", "ls *",
    "git log --pretty --output=out", "git log --format --output=out",
    "git status", "git log", "rg needle input", "rg -e --no-config needle input",
    "rg -- --no-config", "python3 -v", "echo 'print(123)' | python3 -v",
    "constructor", "__proto__", "toString",
    "echo hello |", "| head", "echo hello 2>&1 | | head",
];

for (const command of needsReview) {
    test(`requires review: ${JSON.stringify(command)}`, () => {
        assert.equal(autoPermitted(command), false);
    });
}

for (const command of [
    "git --version", "ls | head -n 20", "ls -la | grep src | wc -l",
    "cat package.json | jq .version", "find . -name '*.ts' | sort | uniq",
    "sort -nr in", "sort -k 2 -t ':' in", "sort -- in", "uniq -c in",
    "uniq -f 1 -s2 -w 3 in", "uniq -- in", "env", "printenv",
    "echo hello | cut -d ':' -f 1 | tr 'a-z' 'A-Z' | column -t",
    "rg --no-config needle input", "rg --no-config --files", "python3 --version", "python3 -V",
    "diff a.txt b.txt", "jq '.items | length' package.json",
    "ls 2>&1", "ls -la 2>/dev/null", "cat file >>/dev/null",
    "echo hello &>/dev/null", "echo hello &>>/dev/null", "echo hello >&-",
    "echo hello >/dev/null 2>&1", "echo hello 1>&2 | head",
    "echo 'a; b || c' | head", "echo '$(literal)'", "echo '>'",
]) {
    test(`permits literal read-only form: ${JSON.stringify(command)}`, () => {
        assert.equal(autoPermitted(command), true);
    });
}

// Vary the spelling and position independently of the implementation's parser.
test("control operators and harmful options stay reviewed across pipeline positions", () => {
    const commands = ["ls", "echo hello", "git status", "sort in", "uniq in"];
    const separators = [" || ", " && ", "; ", "\n", "\r\n", " & "];
    for (const command of commands) {
        for (const separator of separators) {
            const chained = `${command}${separator}bash script.sh`;
            for (const form of [chained, `echo input | ${chained}`, `${chained} | head`]) {
                assert.equal(autoPermitted(form), false, form);
            }
        }
    }
    for (const option of ["-o", "--output", "--compress-program", "--out", "--compress-p"]) {
        for (const spelling of [option, `'${option}'`, `"${option}"`]) {
            for (const form of [`sort ${spelling} target in`, `sort ${spelling}=target in`]) {
                assert.equal(autoPermitted(form), false, form);
                assert.equal(autoPermitted(`cat in | ${form}`), false, form);
            }
        }
    }
    for (const option of ["-exec", "-execdir", "-delete", "-fprint", "-fprintf", "-fls"]) {
        const quoted = option.slice(0, 2) + "'" + option.slice(2) + "'";
        for (const spelling of [option, quoted, `'${option}'`, `"${option}"`]) {
            const form = `find . ${spelling} target`;
            assert.equal(autoPermitted(form), false, form);
            assert.equal(autoPermitted(`${form} | head`), false, form);
        }
    }
});
