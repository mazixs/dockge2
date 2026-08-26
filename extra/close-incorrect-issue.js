import github from "@actions/github";

(async () => {
    try {
        const token = process.argv[2];
        const issueNumber = Number(process.argv[3]);
        const username = process.argv[4];

        if (!token || !Number.isInteger(issueNumber) || !username) {
            throw new Error("Token, issue number and username are required");
        }

        const client = github.getOctokit(token).rest;

        const issue = {
            owner: "louislam",
            repo: "dockge",
            number: issueNumber,
        };

        const labels = (
            await client.issues.listLabelsOnIssue({
                owner: issue.owner,
                repo: issue.repo,
                issue_number: issue.number
            })
        ).data.map(({ name }) => name);

        if (labels.length === 0) {
            console.log("Bad format here");

            await client.issues.addLabels({
                owner: issue.owner,
                repo: issue.repo,
                issue_number: issue.number,
                labels: [ "invalid-format" ]
            });

            // Add the issue closing comment
            await client.issues.createComment({
                owner: issue.owner,
                repo: issue.repo,
                issue_number: issue.number,
                body: `@${username}: Hello! :wave:\n\nThis issue is being automatically closed because it does not follow the issue template. Please DO NOT open a blank issue.`
            });

            // Close the issue
            await client.issues.update({
                owner: issue.owner,
                repo: issue.repo,
                issue_number: issue.number,
                state: "closed"
            });
        } else {
            console.log("Pass!");
        }
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    }

})();
