// @typecheck
/**
 * Organisations that are public knowledge, not personal data.
 *
 * The Organization detector cannot tell "the customer we are discussing" from
 * "the software vendor everyone uses". So a pasted meeting transcript came back
 * with Microsoft, PostNL, Coca-Cola, Capgemini and Power BI each behind an
 * [organization_N] token. That costs real money twice over: the model loses the
 * context it needs to answer well ("[organization_11] licence renewal" means
 * nothing), and the user is shown a mapping table full of names that were never
 * confidential.
 *
 * There is no privacy gain to weigh against it. A listed-company name is not
 * personal data under the GDPR, and none of these is a Bee Flow customer whose
 * relationship needs protecting.
 *
 * ── Rules for this list ───────────────────────────────────────────────────
 *  - Only entries that are unambiguously PUBLIC: listed companies, household
 *    brands, government bodies, and widely-used software products.
 *  - NEVER a name that could plausibly be somebody's employer-as-a-secret,
 *    i.e. anything niche, regional, or B2B-obscure. When in doubt, leave it
 *    out — the cost of omitting an entry is one extra token; the cost of a
 *    wrong entry is an unredacted client name.
 *  - Never personal names, and never applied to the Person category.
 *  - Organisations are matched on their NORMALISED form (case, punctuation and
 *    whitespace removed), so "Coca-Cola", "coca cola" and "CocaCola" all match
 *    one entry. Matching is exact on that form, never substring: "Shell" must
 *    not allowlist "Shell Advies BV".
 *
 * An organisation can switch this list off entirely, and can add its own
 * never-redact terms alongside it — see allowTerms.js.
 */

const PUBLIC_ORGANISATIONS = [
    // Big tech / cloud / SaaS people name constantly in work conversations
    'Microsoft', 'Microsoft 365', 'Office 365', 'Azure', 'Teams', 'SharePoint',
    'OneDrive', 'Outlook', 'Power BI', 'Power Automate', 'Dynamics 365',
    'Google', 'Google Cloud', 'Google Workspace', 'Gmail', 'YouTube', 'Android',
    'Apple', 'iCloud', 'macOS', 'iOS', 'Amazon', 'AWS', 'Amazon Web Services',
    'Meta', 'Facebook', 'Instagram', 'WhatsApp', 'LinkedIn', 'X', 'Twitter',
    'IBM', 'Oracle', 'SAP', 'Salesforce', 'Adobe', 'Cisco', 'Dell', 'HP',
    'Hewlett-Packard', 'Lenovo', 'Intel', 'AMD', 'NVIDIA', 'Samsung', 'Sony',
    'Siemens', 'Philips', 'Bosch', 'Huawei', 'Qualcomm', 'Broadcom',
    'OpenAI', 'ChatGPT', 'Anthropic', 'Claude', 'Mistral', 'Hugging Face',
    'GitHub', 'GitLab', 'Atlassian', 'Jira', 'Confluence', 'Slack', 'Zoom',
    'Notion', 'Figma', 'Canva', 'Dropbox', 'Docker', 'Kubernetes', 'Red Hat',
    'VMware', 'Citrix', 'Fortinet', 'Palo Alto Networks', 'Cloudflare', 'Scaleway',
    'Nextcloud', 'WordPress', 'Shopify', 'Stripe', 'PayPal', 'Adyen', 'Mollie',
    'Exact', 'AFAS', 'Twinfield', 'Visma', 'Unit4', 'TOPdesk', 'Zendesk', 'vPlan',
    'HubSpot', 'Mailchimp', 'Trello', 'Asana', 'Monday.com', 'ServiceNow',

    // IT services / consulting (public, and named as vendors not as clients)
    'Capgemini', 'Accenture', 'Deloitte', 'KPMG', 'PwC', 'EY', 'McKinsey',
    'Infosys', 'Cognizant', 'Atos', 'Sopra Steria', 'Ordina', 'Centric',
    'CGI', 'TCS', 'Tata Consultancy Services', 'Wipro',

    // Dutch / Benelux household names
    'PostNL', 'DHL', 'UPS', 'FedEx', 'DPD', 'GLS',
    'ING', 'Rabobank', 'ABN AMRO', 'SNS', 'Bunq', 'Knab', 'Triodos',
    'Achmea', 'Aegon', 'NN', 'Nationale-Nederlanden', 'Centraal Beheer',
    'Zilveren Kruis', 'VGZ', 'CZ', 'Menzis', 'DSW',
    'KPN', 'Ziggo', 'VodafoneZiggo', 'Vodafone', 'T-Mobile', 'Odido',
    'Albert Heijn', 'Jumbo', 'Lidl', 'Aldi', 'Plus', 'Coop', 'Dirk',
    'Bol', 'Bol.com', 'Coolblue', 'Wehkamp', 'Zalando', 'Amazon.nl',
    'Shell', 'BP', 'Total', 'TotalEnergies', 'Eneco', 'Vattenfall', 'Essent',
    'Heineken', 'Grolsch', 'Bavaria', 'Unilever', 'Friesland Campina', 'Ahold',
    'Ahold Delhaize', 'Randstad', 'Adecco', 'Manpower', 'Tempo-Team',
    'NS', 'ProRail', 'Schiphol', 'KLM', 'Transavia', 'Connexxion', 'Arriva',
    'ANWB', 'Rijkswaterstaat', 'Belastingdienst', 'UWV', 'SVB', 'KvK',
    'Kamer van Koophandel', 'RDW', 'CBS', 'RIVM', 'DUO', 'Kadaster',

    // Global consumer brands that turn up as examples
    'Coca-Cola', 'Pepsi', 'Nestlé', 'McDonald\'s', 'Starbucks', 'IKEA',
    'Nike', 'Adidas', 'Puma', 'BMW', 'Mercedes-Benz', 'Volkswagen', 'Audi',
    'Toyota', 'Tesla', 'Ford', 'Renault', 'Peugeot', 'Volvo', 'Netflix',
    'Spotify', 'Disney', 'Booking.com', 'Airbnb', 'Uber', 'Bosch', 'Miele',
];

module.exports = { PUBLIC_ORGANISATIONS };
