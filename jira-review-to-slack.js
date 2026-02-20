#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable no-await-in-loop */
// jira-review-to-slack.js
// Usage: node scripts/jira-review-to-slack.js <PROJECT_KEY>
// Example: node scripts/jira-review-to-slack.js SKD

require('dotenv').config();
const fs = require('fs');
const { exec } = require('child_process');

let sortableCheckbox = require('inquirer-sortable-checkbox');
if (
  sortableCheckbox &&
  typeof sortableCheckbox !== 'function' &&
  typeof sortableCheckbox.default === 'function'
) {
  sortableCheckbox = sortableCheckbox.default;
}

const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_TOKEN = process.env.JIRA_TOKEN;

if (!JIRA_HOST || !JIRA_EMAIL || !JIRA_TOKEN) {
  console.error('Missing required environment variables. Please copy .env.example to .env and fill in your credentials.');
  process.exit(1);
}

const BOARD_CONFIG = {
  SKD: {
    reviewStatuses: ['Reviewing'],
    testStatuses: [],
    // Labels to exclude from selection
    excludeLabels: {
      review: ['external-review'],
      test: ['external-test'],
    },
  },
  LCM: {
    reviewStatuses: ['Reviewing'],
    testStatuses: ['Dev Done'],
    // Labels to exclude from selection
    excludeLabels: {
      review: ['external-review'],
      test: ['external-test'],
    },
  },
  // Add more boards as needed
};

const REPO_ABBREVIATIONS = {
  'seismic/readiness-bff-service': 'RBFF',
  'lessonly/skills': 'SkillsBE',
  'seismic/learning-assessment-review-service': 'LARS',
  'seismic/web-skills-assets': 'WSA',
  'seismic/web-scorecards-assets': 'WSCA',
  'lessonly/lessonly': 'Lessonly',
  'seismic/web-learning-lesson-manager-assets': 'LessonManager',
  'seismic/web-learning-lesson-builder': 'LessonBuilder',
  'seismic/web-learning-elements-assets': 'ElementsLibrary',
  'seismic/web-learning-generation-assets': 'AiLessonBuilder'
  // Add more as needed
};

const EMOJI_NUMBERS = [
  ':one:',
  ':two:',
  ':three:',
  ':four:',
  ':five:',
  ':six:',
  ':seven:',
  ':eight:',
  ':nine:',
  ':keycap_ten:',
];

function getBoardConfig(project) {
  const config = BOARD_CONFIG[project];
  
  if (!config) {
    console.warn(`No board configuration found for ${project}. Using defaults.`);
    return {
      reviewStatuses: ['Reviewing'],
      testStatuses: [],
      excludeLabels: {
        review: [],
        test: [],
      },
    };
  }
  
  return config;
}

async function searchIssueByJQL(jql) {
  const authHeader =
    'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const searchUrl = `${JIRA_HOST}/rest/api/3/search/jql`;

  console.warn('Searching for issues with JQL:', jql);
  console.warn(
    'Using POST /rest/api/3/search per Atlassian CHANGE-2046 migration guidance.',
  );

  const resp = await fetch(searchUrl, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jql,
      fields: ['summary', 'status', 'labels'],
      maxResults: 100,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `JIRA search (POST) failed: ${resp.status} ${resp.statusText} ${text}`,
    );
  }

  const searchResults = await resp.json();
  console.warn('Found issues:', (searchResults.issues || []).length);

  return searchResults.issues || [];
}

async function enrichWithDevStatus(issue) {
  const authHeader =
    'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const devStatusUrl = `${JIRA_HOST}/rest/dev-status/1.0/issue/detail?issueId=${issue.id}&applicationType=GitHub&dataType=pullrequest`;
  const resp = await fetch(devStatusUrl, {
    method: 'GET',
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) return null;
  const devStatus = await resp.json();
  return devStatus;
}

function getRepoAbbreviation(repoName) {
  return REPO_ABBREVIATIONS[repoName] || repoName;
}

function formatSlackLine(emoji, repoAbbr, prNumber, issueKeys, summary, prUrl) {
  // issueKeys can be a string or an array
  const keys = Array.isArray(issueKeys) ? issueKeys : [issueKeys];
  const issueKeyLinks = keys.map(key => {
    const jiraUrl = `${JIRA_HOST}/browse/${key}`;
    return `<${jiraUrl}|[${key}]>`;
  }).join(' / ');
  let prText = `${repoAbbr}#${prNumber}${summary ? ' ' + summary : ''}`;
  if (prUrl && prNumber && prNumber !== '???') {
    prText = `<${prUrl}|${prText}>`;
  }
  return `${emoji} ${issueKeyLinks} ${prText}`;
}

function formatHtmlLine(emoji, repoAbbr, prNumber, issueKeys, summary, prUrl) {
  // issueKeys can be a string or an array
  const keys = Array.isArray(issueKeys) ? issueKeys : [issueKeys];
  const issueKeyLinks = keys.map(key => {
    const jiraUrl = `${JIRA_HOST}/browse/${key}`;
    return `<a href="${jiraUrl}">[${key}]</a>`;
  }).join(' / ');
  let prText = `${repoAbbr}#${prNumber}${summary ? ' ' + summary : ''}`;
  if (prUrl && prNumber && prNumber !== '???') {
    prText = `<a href="${prUrl}">${prText}</a>`;
  }
  return `<li>${emoji} ${issueKeyLinks} ${prText}</li>`;
}

async function inspectTicket(ticketKey) {
  console.log(`\nInspecting ticket: ${ticketKey}\n`);
  
  const authHeader = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString('base64');
  const issueUrl = `${JIRA_HOST}/rest/api/3/issue/${ticketKey}`;
  
  const resp = await fetch(issueUrl, {
    method: 'GET',
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
    },
  });
  
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Failed to fetch ticket: ${resp.status} ${resp.statusText} ${text}`);
  }
  
  const issue = await resp.json();
  
  console.log('Ticket Information:');
  console.log('═══════════════════════════════════════');
  console.log(`Key:           ${issue.key}`);
  console.log(`Summary:       ${issue.fields.summary}`);
  console.log(`Status:        ${issue.fields.status.name} (id: ${issue.fields.status.id})`);
  console.log(`Project:       ${issue.fields.project.key}`);
  console.log(`Issue Type:    ${issue.fields.issuetype.name}`);
  
  if (issue.fields.labels && issue.fields.labels.length > 0) {
    console.log(`Labels:        ${issue.fields.labels.join(', ')}`);
  }
  
  if (issue.fields.sprint) {
    console.log(`Sprint:        ${issue.fields.sprint.name}`);
  }
  
  console.log('\n📋 Use this status name in your board config:');
  console.log(`   "${issue.fields.status.name}"`);
  
  // Get dev status for PRs
  const devStatus = await enrichWithDevStatus(issue);
  if (devStatus && devStatus.detail && devStatus.detail[0] && devStatus.detail[0].pullRequests) {
    const prs = devStatus.detail[0].pullRequests;
    console.log(`\n🔗 Pull Requests (${prs.length}):`);
    prs.forEach(pr => {
      const repoName = pr.repositoryName || pr.repository?.name || 'unknown';
      const prNumber = pr.id ? pr.id.replace(/^#/, '') : '???';
      console.log(`   ${pr.status === 'OPEN' ? '🟢' : '🔴'} ${repoName}#${prNumber} - ${pr.status}`);
      console.log(`      ${pr.url}`);
    });
  } else {
    console.log('\n🔗 No pull requests found');
  }
  
  console.log('\n');
}

async function main() {
  const args = process.argv.slice(2);
  
  // Check for --inspect flag
  if (args[0] === '--inspect' && args[1]) {
    await inspectTicket(args[1]);
    return;
  }
  
  const [project] = args;
  if (!project) {
    console.error('Usage: node scripts/jira-review-to-slack.js <PROJECT_KEY>');
    console.error('   or: node scripts/jira-review-to-slack.js --inspect <TICKET-KEY>');
    process.exit(1);
  }
  
  const config = getBoardConfig(project);
  const allStatuses = [...config.reviewStatuses, ...config.testStatuses];
  
  console.log(`\nBoard configuration for ${project}:`);
  console.log(`  Review columns: ${config.reviewStatuses.join(', ')}`);
  console.log(`  Test columns: ${config.testStatuses.join(', ') || '(none)'}`);
  console.log();
  
  // JQL Query explanation:
  // - project = "${project}" : Only tickets from the specified project
  // - status in (...) : Only tickets in the configured status columns (e.g., 'Reviewing', 'Testing')
  // - development[pullrequests].open > 0 : Only tickets with at least one open PR
  // - Sprint in openSprints() : Only tickets in currently active sprints
  const jql = `project = "${project}" AND status in (${allStatuses.map(s => `'${s}'`).join(', ')}) AND development[pullrequests].open > 0 AND Sprint in openSprints()`;
  const issues = await searchIssueByJQL(jql);
  
  // Build PRs as objects without emoji for selection/reordering
  const prItems = [];
  for (const issue of issues) {
    const devStatus = await enrichWithDevStatus(issue);
    if (
      !devStatus ||
      !devStatus.detail ||
      !devStatus.detail[0] ||
      !devStatus.detail[0].pullRequests
    )
      continue;
    
    const issueStatus = issue.fields?.status?.name || 'Unknown';
    const isReview = config.reviewStatuses.includes(issueStatus);
    const isTest = config.testStatuses.includes(issueStatus);
    const column = isReview ? 'review' : isTest ? 'test' : 'unknown';
    
    // Check for excluded labels on the Jira issue
    const issueLabels = (issue.fields?.labels || []).map(l => l.toLowerCase());
    const excludedLabelsForColumn = config.excludeLabels?.[column] || [];
    const hasExcludedLabel = issueLabels.some(label => 
      excludedLabelsForColumn.some(excluded => label.toLowerCase() === excluded.toLowerCase())
    );
    
    for (const pr of devStatus.detail[0].pullRequests) {
      const repoName = pr.repositoryName || pr.repository?.name || '';
      const repoAbbr = getRepoAbbreviation(repoName);
      if (!repoAbbr) {
        continue;
      }
      if (pr.status && pr.status !== 'OPEN') {
        continue;
      }
      const prNumber = pr.id ? pr.id.replace(/^#/, '') : '???';
      const summary = issue.fields?.summary || '(no summary)';
      const issueKey = issue.key || `ID:${issue.id}`;
      
      prItems.push({
        repoAbbr,
        prNumber,
        issueKey,
        summary,
        prUrl: pr.url,
        column,
        issueStatus,
        display: `[${column.toUpperCase()}] ${repoAbbr}#${prNumber}: [${issueKey}] ${summary}`,
        hasExcludedLabel,
      });
    }
  }
  if (prItems.length === 0) {
    console.log('No issues with open PRs found.');
    return;
  }

  // Single interactive step: select and reorder
  const answer = await sortableCheckbox({
    message:
      'Select and reorder PRs for Slack message. Use space to select/deselect, arrows to move, Enter to confirm order.',
    choices: prItems.map((pr, idx) => ({
      name: pr.display,
      value: idx,
      checked: !pr.hasExcludedLabel, // Auto-deselect PRs with excluded labels
    })),
    pageSize: 15,
  });

  if (!answer || !answer.length) {
    console.log('No PRs selected. Exiting.');
    return;
  }

  // Get selected PRs in order
  const selectedPRs = answer.map(idx => prItems[idx]);

  // Group selected PRs by URL and column to combine tickets referencing the same PR in the same column
  const prsByUrlAndColumn = new Map();
  for (const pr of selectedPRs) {
    const key = `${pr.prUrl}|${pr.column}`;
    if (!prsByUrlAndColumn.has(key)) {
      prsByUrlAndColumn.set(key, []);
    }
    prsByUrlAndColumn.get(key).push(pr);
  }

  // Create consolidated PR items maintaining the original order
  const consolidatedPRs = [];
  const seenKeys = new Set();
  for (const pr of selectedPRs) {
    const key = `${pr.prUrl}|${pr.column}`;
    if (seenKeys.has(key)) {
      continue; // Already processed this PR URL + column combination
    }
    seenKeys.add(key);
    
    const prsForThisKey = prsByUrlAndColumn.get(key);
    if (prsForThisKey.length > 1) {
      // Multiple tickets reference the same PR in the same column - combine them
      const issueKeys = prsForThisKey.map(p => p.issueKey);
      consolidatedPRs.push({
        repoAbbr: pr.repoAbbr,
        prNumber: pr.prNumber,
        issueKey: issueKeys, // Array of issue keys
        summary: pr.summary,
        prUrl: pr.prUrl,
        column: pr.column,
      });
    } else {
      // Single ticket for this PR in this column - keep as is
      consolidatedPRs.push(pr);
    }
  }

  // Group consolidated PRs by column
  const reviewPRs = consolidatedPRs.filter(pr => pr.column === 'review');
  const testPRs = consolidatedPRs.filter(pr => pr.column === 'test');
  
  // Compose final lines with emojis, grouped by column
  const finalLines = [];
  const htmlLines = [];
  
  if (reviewPRs.length > 0) {
    finalLines.push('*Review:*');
    htmlLines.push('<h3>Review:</h3>', '<ul>');
    reviewPRs.forEach((pr, idx) => {
      const emoji = EMOJI_NUMBERS[idx] || ':grey_question:';
      finalLines.push(formatSlackLine(emoji, pr.repoAbbr, pr.prNumber, pr.issueKey, pr.summary, pr.prUrl));
      htmlLines.push(formatHtmlLine(emoji, pr.repoAbbr, pr.prNumber, pr.issueKey, pr.summary, pr.prUrl));
    });
    htmlLines.push('</ul>');
  }
  
  if (testPRs.length > 0) {
    if (reviewPRs.length > 0) {
      finalLines.push(''); // Add blank line between sections
    }
    finalLines.push('*Testing:*');
    htmlLines.push('<h3>Testing:</h3>', '<ul>');
    testPRs.forEach((pr, idx) => {
      const emoji = EMOJI_NUMBERS[idx] || ':grey_question:';
      finalLines.push(formatSlackLine(emoji, pr.repoAbbr, pr.prNumber, pr.issueKey, pr.summary, pr.prUrl));
      htmlLines.push(formatHtmlLine(emoji, pr.repoAbbr, pr.prNumber, pr.issueKey, pr.summary, pr.prUrl));
    });
    htmlLines.push('</ul>');
  }
  
  console.log('\nFinal Slack message:');
  console.log(finalLines.join('\n'));
  const htmlString = htmlLines.join('\n');
  console.log('\nHTML for rich paste:');
  console.log(htmlString);

  // Write HTML to a file and open in Chrome (macOS)
  const htmlFile = 'slack_prs.html';
  fs.writeFileSync(htmlFile, htmlString, 'utf8');
  // Try to open in Chrome, fallback to default browser if not found
  exec('open -a "Google Chrome" ' + htmlFile + ' || open ' + htmlFile);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});