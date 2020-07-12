import * as config from "./config.json";

import * as fs from "fs";

import {client} from "./client.js";
import {logger} from "./logger.js";
import * as util from "./util.js";
import importFresh = require("import-fresh");
import type {CollectorFilter, Message, PartialMessage, PartialUser, Snowflake} from "discord.js";
import {GuildMember, MessageEmbed, MessageReaction, TextChannel, User} from "discord.js";

const validSubmissionChannels: Snowflake[] = config.validSubmissionChannels;
const rolesThatCanRemoveSubmissions: Snowflake[] = config.rolesThatCanRemoveSubmissions;
const roleSuggestionId: Snowflake = config.roleSuggestionId;
const roleBugId: Snowflake = config.roleBugId;

//recognize submission and store to files
client.on('message', async (message: Message | PartialMessage) => {
	if (message.author.bot) return;

	if (message.guild === null) return;

	await validateSubmission(message);
});

//delete files when message gests deleted
client.on("messageDelete", async (msg) => {
	if (!util.sentFromValidChannel(msg, validSubmissionChannels)) return;
	logger.info("message deleted. " + msg.id + ".json    checking for files")
	scanAndRemoveFile(msg);
})

//remove all reaction and delete file if reacted to the X emoji
client.on("messageReactionAdd", async (reaction: MessageReaction, user: User | PartialUser) => {
	if (reaction.partial) {
		try {
			await reaction.fetch();
		} catch (err) {
			logger.error("error while fetching reaction partial: ", err);
			return;
		}
	}

	if (user.bot) return;

	logger.debug("begin reaction added handler");

	if (!util.sentFromValidChannel(reaction.message, validSubmissionChannels)) return;

	//logger.debug("valid channel");
	//logger.debug("reaction emoji ", reaction.emoji.name);

	if (reaction.emoji.name !== "❌") return;

	//logger.debug("correct emoji");

	let member: GuildMember = reaction.message.guild.member(user.id);
	if (!member) return;

	//logger.debug("member ", member);
	if (!reaction.message.reactions.cache.some((react: MessageReaction) => react.emoji.name === "🤖")) return;

	//check if member has special role;
	let allowedToRemove: boolean = reaction.message.author.id === user.id;
	allowedToRemove = allowedToRemove || member.roles.cache.some(role => rolesThatCanRemoveSubmissions.includes(role.id));
	if (!allowedToRemove) return;

	logger.debug("right role, clearing reactions and removing file");
	//all conditions clear?
	reaction.message.reactions.removeAll().catch(err => logger.error("failed to clear all reactions: ", err));
	scanAndRemoveFile(reaction.message);

	logger.debug("reaction handler done");
});

async function validateSubmission(message: Message | PartialMessage) {
	logger.debug("Message: " + message.content + " in channel: #" + (<TextChannel>message.channel).name);

	if (!util.sentFromValidChannel(message, validSubmissionChannels))
		return;

	const roles = message.mentions.roles;
	if (!roles) return;

	let submission: boolean = false;
	let bug: boolean = false;
	if (roles.get(roleSuggestionId)) submission = true;
	if (roles.get(roleBugId)) bug = true;

	if (!(submission || bug)) return;

	let msg = message;
	const match: RegExpMatchArray = message.content.match(/^<@&\d+> above (\d+)$/);
	logger.debug("match: ", match);
	if (match) {
		const target: number = Number(match[1]) + 1;
		//logger.debug("target: ", target);
		if (message.channel.messages.cache.array().length < target) {
			await message.channel.messages.fetch({limit: target}).catch((err) => logger.error("issue while fetching messages ", err));
		}
		let msgs = message.channel.messages.cache.last(target);
		let targetMessage = msgs[msgs.length - 1];
		logger.debug("tm1  ", targetMessage);
		msg = targetMessage;
		message.delete().catch((err) => logger.error("issue while deleting message ", err.toString()));
		if (bug) handleSubmission(msg, "bug");
		if (submission) handleSubmission(msg, "suggestion");
		return;
	}

	if (bug) handleSubmission(msg, "bug");
	if (submission) await confirmSuggestion(msg);
}

async function confirmSuggestion(msg: Message | PartialMessage): Promise<void> {

	if (!isFirstSuggestion(msg.author)) {
		handleSubmission(msg, "suggestion");
		return;
	}

	const embed: MessageEmbed = new MessageEmbed()
		.setDescription("You are about to submit your first suggestion. I'm sure its a great idea, but maybe you aren't the first one to have it, check [this](https://docs.google.com/spreadsheets/d/1pwX1ZlIIVeLoPXmjNl3amU4iPKpEcbl4FWkOzmYZG5w) spreadsheet to see if its already suggested.\nTry searching for keywords with ctrl + F :)")
		.setColor(6724095)
		.addField("Confirm", "Click on the ✅ Checkmark to confirm your submission")
		.addField("Nevermind", "You have 5 minutes to confirm your submission, otherwise it will just get deleted")
		.addField("Only once", "This message will NOT appear on your future submission. If you need to check the spreadsheet again type `!suggested`");

	let replyMsg: Message = await msg.reply(embed);
	replyMsg.react("✅").catch(err => logger.error("issue while adding reactions :(", err));
	const filter: CollectorFilter = (reaction, user) => {
		//logger.debug("filter: u.id:"+user.id + "  a.id:"+msg.author.id);
		return reaction.emoji.name === "✅" && user.id === msg.author.id;
	};
	replyMsg.awaitReactions(filter, {max: 1, time: 300000, errors: ["time"]})
		.then(_collected => {
			//logger.debug("collection success");
			let embed: MessageEmbed = new MessageEmbed()
				.setDescription("Thank you for your contribution!");
			replyMsg.edit(embed);
			handleSubmission(msg, "suggestion");
			addUserToList(msg.author);
			setTimeout(() => replyMsg.delete(), 5000);
		})
		.catch(_collected => {
			replyMsg.delete();
			msg.delete();
		});

}

function isFirstSuggestion(user): boolean {
	const users: any = importFresh("./data/users.json");
	//logger.debug("list: ",users.suggestors);
	return !users.suggestors.includes(user.id);
}

function addUserToList(user): void {
	const users: any = importFresh("./data/users.json");
	users.suggestors.push(user.id);
	fs.writeFile("./data/users.json", JSON.stringify(users, null, 4), function (err) {
		if (err) throw err;
		logger.info("added user " + user.id + " to the suggestions list");
	});
}

function handleSubmission(msg, type) {
	logger.info("handling submission: " + msg.content + " of type " + type);

	//save info to local file
	createFile(msg, type);

	//add reactions
	msg.react("🤖")
		.then(() => msg.react("👍"))
		.then(() => msg.react("👎"))
		.then(() => msg.react("❌"))
		.catch(() => logger.error("issue while adding reactions :("));
}

function createFile(msg, subDirectory) {
	//subDirectory should be either suggestion or bug
	const msgTitle: string = msg.id + ".json";
	const msgLink: string = "https://discordapp.com/channels/" + msg.guild.id + "/" + msg.channel.id + "/" + msg.id;
	const msgJson: any = {
		"link": msgLink,
		"type": subDirectory,
		"author": msg.author.tag,
		"msg": msg.content
	};
	fs.writeFile("./data/" + subDirectory + "s/" + msgTitle, JSON.stringify(msgJson, null, 4), function (err) {
		if (err) throw err;
		logger.info("saved to file: " + msgTitle);
	});
}

function scanAndRemoveFile(msg: Message | PartialMessage) {
	const msgTitle = msg.id + ".json";
	//suggestions
	fs.access("./data/suggestions/" + msgTitle, (err) => {
		if (err) logger.warn("could not find ./data/suggestions/" + msgTitle + "  didnt't delete");
		else removeFile(msgTitle, "suggestion");
	});
	//bugs
	fs.access("./data/bugs/" + msgTitle, (err) => {
		if (err) logger.warn("could not find ./data/bugs/" + msgTitle + "  didnt't delete");
		else removeFile(msgTitle, "bug");
	});
}

function removeFile(title: string, subDirectory: "suggestion" | "bug") {
	//subDirectory should be either suggestion or bug
	fs.unlink("./data/" + subDirectory + "s/" + title, (err) => {
		if (err) logger.error("issue while removing file ", err);
		else logger.info("removed file: " + title + " of type " + subDirectory);
	});
}