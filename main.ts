import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { createClient, SupabaseClient } from '@supabase/supabase-js'


interface Tweet {
	created_at: string;
	full_text: string;
	tweet_id: string;
}

async function getTweetsPaginated(client: SupabaseClient, accountId: string, latest_id: string | null) {
	let allTweets: Tweet[] = [];
	let batchSize = 1000;
	let offset = 0;
	let done = false;

	while (!done) {
		let query = client
			.schema('public')
			.from('tweets')
			.select('*')
			.eq('account_id', accountId)
			.order('tweet_id', { ascending: false })
			.range(offset, offset + batchSize - 1); // Fetch a batch of 1000

		if (latest_id) {
			query = query.gt('tweet_id', latest_id);
		}

		const { data, error } = await query;

		if (error) {
			throw error;
		}

		if (data.length === 0) {
			done = true; // If no data is returned, we are done
		} else {
			console.log(`Got ${data.length} tweets, fetching another page...`)
			allTweets = allTweets.concat(data);
			offset += batchSize;
		}
	}

	return allTweets;
}

function formatTweetsToMarkdown(username: string, dateFormat: string, tweets: Tweet[]): string {
	return tweets.map(tweet => {
		const date = window.moment(tweet.created_at).format(dateFormat);
		return `## [${tweet.tweet_id}](https://twitter.com/${username}/status/${tweet.tweet_id})\n*${date}*\n\n${tweet.full_text}\n\n---\n`;
	}).join('\n');
}

async function syncData(plugin: CAPlugin) {
	const client = createClient(plugin.settings.apiURL, plugin.settings.authToken);

	// Read last synced tweet ID
	let lastTweetId = null;
	try {
		lastTweetId = await plugin.app.vault.adapter.read('.last_tweet_id');
	} catch (error) {
		console.log('No previous sync found');
	}

	const tweets = await getTweetsPaginated(client, plugin.settings.accountID, lastTweetId);
	console.log(`total ${tweets.length} tweets fetched`);

	if (tweets.length > 0) {
		const latest = tweets[tweets.length - 1];
		console.log(`latest tweet id: ${latest.tweet_id}`);
		// Save the latest tweet ID
		await plugin.app.vault.adapter.write('.last_tweet_id', latest.tweet_id);

		// Format tweets and write to file
		const markdown = formatTweetsToMarkdown(plugin.settings.username, plugin.settings.dateFormat, tweets);
		try {
			// Read existing content if file exists
			let existingContent = '';
			try {
				existingContent = await plugin.app.vault.adapter.read(plugin.settings.filePath);
			} catch (error) {
				// File doesn't exist yet, that's okay
			}

			// Prepend new tweets to existing content
			const newContent = markdown + (existingContent ? '\n' + existingContent : '');
			await plugin.app.vault.adapter.write(plugin.settings.filePath, newContent);
		} catch (error) {
			throw new Error(`Failed to write tweets to file: ${error}`);
		}
	}
}

interface CAPluginSettings {
	username: string;
	accountID: string;
	apiURL: string;
	authToken: string;
	filePath: string;
	dateFormat: string;
}

const DEFAULT_SETTINGS: CAPluginSettings = {
	username: 'default',
	accountID: 'default',
	apiURL: 'https://fabxmporizzqflnftavs.supabase.co',
	authToken: 'secret',
	filePath: 'test_tweets.md',
	dateFormat: 'YYYY-MM-DD HH:mm:ss'
}

export default class CAPlugin extends Plugin {
	settings: CAPluginSettings;

	async onload() {
		await this.loadSettings();

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'sync-data',
			name: 'Sync your data',
			callback: async () => {
				try {
					await syncData(this);
					new Notice("Data synced successfully");
				} catch (error) {
					new Notice(`Failed to sync data: ${error}`);
				}
			}
		});

		this.addCommand({
			id: 'clean-sync-state',
			name: 'Clean sync state',
			callback: async () => {
				try {
					await this.app.vault.adapter.remove('.last_tweet_id');
					new Notice('Sync state cleaned successfully');
				} catch (error) {
					new Notice('No sync state found to clean');
				}
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new CAPluginSettingTab(this.app, this));
	}

	onunload() {

	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class CAPluginSettingTab extends PluginSettingTab {
	plugin: CAPlugin;

	constructor(app: App, plugin: CAPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Output File Location')
			.setDesc('The path where your tweets will be saved (e.g., "tweets/archive.md")')
			.addText(text => text
				.setPlaceholder('tweets/archive.md')
				.setValue(this.plugin.settings.filePath)
				.onChange(async (value) => {
					this.plugin.settings.filePath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Twitter Handle')
			.setDesc('Your Twitter username without the @ symbol')
			.addText(text => text
				.setPlaceholder('username')
				.setValue(this.plugin.settings.username)
				.onChange(async (value) => {
					this.plugin.settings.username = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Twitter Account ID')
			.setDesc('Your numeric Twitter account ID (required for data retrieval)')
			.addText(text => text
				.setPlaceholder('123456789')
				.setValue(this.plugin.settings.accountID)
				.onChange(async (value) => {
					this.plugin.settings.accountID = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Supabase API URL')
			.setDesc('The URL of your Supabase instance (provided by Community Archive)')
			.addText(text => text
				.setPlaceholder('https://your-project.supabase.co')
				.setValue(this.plugin.settings.apiURL)
				.onChange(async (value) => {
					this.plugin.settings.apiURL = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Supabase API Key')
			.setDesc('Your Supabase API key (provided by Community Archive)')
			.addText(text => text
				.setPlaceholder('your-api-key')
				.setValue(this.plugin.settings.authToken)
				.onChange(async (value) => {
					this.plugin.settings.authToken = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Tweet Date Format')
			.setDesc('How dates should appear in your archive. Uses Moment.js format (e.g., "YYYY-MM-DD HH:mm:ss" or "MMMM Do, YYYY")')
			.addText(text => text
				.setPlaceholder('YYYY-MM-DD HH:mm:ss')
				.setValue(this.plugin.settings.dateFormat)
				.onChange(async (value) => {
					this.plugin.settings.dateFormat = value;
					await this.plugin.saveSettings();
				}));
	}
}
