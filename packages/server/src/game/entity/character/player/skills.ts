import Accuracy from './skill/impl/accuracy';
import Archery from './skill/impl/archery';
import Health from './skill/impl/health';
import Lumberjacking from './skill/impl/lumberjacking';
import Magic from './skill/impl/magic';
import Strength from './skill/impl/strength';
import Mining from './skill/impl/mining';
import Defense from './skill/impl/defense';
import Fishing from './skill/impl/fishing';
import Cooking from './skill/impl/cooking';
import Smithing from './skill/impl/smithing';
import Crafting from './skill/impl/crafting';
import Fletching from './skill/impl/fletching';
import Foraging from './skill/impl/foraging';
import Eating from './skill/impl/eating';
import Loitering from './skill/impl/loitering';
import Alchemy from './skill/impl/alchemy';

import Formulas from '../../../../info/formulas';

import log from '@kaetram/common/util/log';

import { Modules, Opcodes } from '@kaetram/common/network';
import { ExperiencePacket, PointsPacket, SkillPacket } from '@kaetram/common/network/impl';

import type Player from './player';
import type Skill from './skill/skill';
import type { SerializedSkills, SkillData } from '@kaetram/common/network/impl/skill';

export default class Skills {
    private loaded = false;

    private accuracy: Accuracy = new Accuracy();
    private archery: Archery = new Archery();
    private health: Health = new Health();
    private lumberjacking: Lumberjacking = new Lumberjacking();
    private magic: Magic = new Magic();
    private strength: Strength = new Strength();
    private mining: Mining = new Mining();
    private defense: Defense = new Defense();
    private fishing: Fishing = new Fishing();
    private cooking: Cooking = new Cooking();
    private smithing: Smithing = new Smithing();
    private crafting: Crafting = new Crafting();
    private fletching: Fletching = new Fletching();
    private foraging: Foraging = new Foraging();
    private eating: Eating = new Eating();
    private loitering: Loitering = new Loitering();
    private alchemy: Alchemy = new Alchemy();

    private skills: { [key: string]: Skill } = {
        [Modules.Skills.Accuracy]: this.accuracy,
        [Modules.Skills.Archery]: this.archery,
        [Modules.Skills.Health]: this.health,
        [Modules.Skills.Lumberjacking]: this.lumberjacking,
        [Modules.Skills.Magic]: this.magic,
        [Modules.Skills.Strength]: this.strength,
        [Modules.Skills.Mining]: this.mining,
        [Modules.Skills.Defense]: this.defense,
        [Modules.Skills.Fishing]: this.fishing,
        [Modules.Skills.Cooking]: this.cooking,
        [Modules.Skills.Smithing]: this.smithing,
        // [Modules.Skills.Smelting]: this.smelting,
        [Modules.Skills.Crafting]: this.crafting,
        [Modules.Skills.Fletching]: this.fletching,
        [Modules.Skills.Foraging]: this.foraging,
        [Modules.Skills.Eating]: this.eating,
        [Modules.Skills.Loitering]: this.loitering,
        [Modules.Skills.Alchemy]: this.alchemy
    };

    private loadCallback?: () => void;

    public constructor(private player: Player) {}

    /**
     * Iterates through the data from the database and finds the
     * matching skill based on the type. Loads the experience into
     * that skill if found.
     * @param data Raw database data containing skill type and experience.
     */

    public load(data: SkillData[]): void {
        // Load each skill from the database (empty if new player).
        for (let skillData of data) {
            let skill = this.get(skillData.type);

            if (skill) skill.setExperience(skillData.experience);
        }

        // Create a callback that links to `handleExperience` for every skill.
        this.forEachSkill((skill: Skill) => skill.onExperience(this.handleExperience.bind(this)));

        this.loaded = true;

        this.loadCallback?.();
        this.sync();
    }

    /**
     * Synchronizes the player's health, mana, and level with the client and sends
     * all the necessary packets.
     */

    public sync(): void {
        // Prevent a sync prior to loading from messing up player information.
        if (!this.loaded) return;

        let health = this.get(Modules.Skills.Health),
            magic = this.get(Modules.Skills.Magic);

        // Update max hit points and mana.
        this.player.hitPoints.setMaxHitPoints(Formulas.getMaxHitPoints(health.level));
        this.player.mana.setMaxMana(Formulas.getMaxMana(magic.level));

        // Update the player's level.
        this.player.level = this.getCombatLevel();

        // Synchronize the player's level packet.
        this.player.send(
            new ExperiencePacket(Opcodes.Experience.Sync, {
                instance: this.player.instance,
                level: this.player.level
            })
        );

        // Synchronize mana and hit points.
        this.player.send(
            new PointsPacket({
                instance: this.player.instance,
                hitPoints: this.player.hitPoints.getHitPoints(),
                maxHitPoints: this.player.hitPoints.getMaxHitPoints(),
                mana: this.player.mana.getMana(),
                maxMana: this.player.mana.getMaxMana()
            })
        );
    }

    /**
     * Skills such as lumberjacking may have loops that need to be stopped
     * whenever an action such as movement or being attacked occurs. This is
     * an overload function that calls the stop() function on all skills.
     */

    public stop(): void {
        this.forEachSkill((skill: Skill) => skill.stop());
    }

    /**
     * Handles skill-based experience gain.
     * @param type The skill that gained experience.
     * @param name The name of the skill.
     * @param withINfo Whether or not to display the experience popup on the client.
     * @param experience The amount of experience the skill has.
     * @param level The amount of levels the skill has.
     * @param newLevel Whether the player has gained a new level.
     */

    private handleExperience(
        type: Modules.Skills,
        name: string,
        withInfo: boolean,
        experience: number,
        level: number,
        newLevel = false
    ): void {
        if (newLevel) {
            this.player.popup(
                `misc:SKILL_LEVEL_UP`,
                `misc:SKILL_LEVEL_UP_DESC;name=${name};level=${level}`,
                '#9933ff'
            );

            // Update the player's max health if they have gained a level in health skill.
            if (type === Modules.Skills.Health)
                this.player.setHitPoints(Formulas.getMaxHitPoints(level));

            // Update the player's level if they have gained a level in a combat skill.
            this.sync();

            // Queue $NUT reward for skill level-up milestone.
            this.queueLevelReward(name, level);
        }

        if (withInfo)
            this.player.send(
                new ExperiencePacket(Opcodes.Experience.Skill, {
                    instance: this.player.instance,
                    amount: experience,
                    skill: type
                })
            );

        this.player.send(new SkillPacket(Opcodes.Skill.Update, this.skills[type].serialize(true)));
    }

    /**
     * Queues $NUT rewards when a player hits a milestone level in any skill.
     * Fire-and-forget async — reads from level_rewards config in MongoDB.
     * @param skillName The name of the skill that leveled up.
     * @param level The new level reached.
     */

    private queueLevelReward(skillName: string, level: number): void {
        if (!this.player.walletAddress) return;

        const wallet = this.player.walletAddress;
        const username = this.player.username;

        Promise.resolve().then(async () => {
            const db = this.player.database.getDb?.();
            if (!db) return;

            // Find the highest milestone at or below the current level
            const rewardConfig = await db.collection('level_rewards')
                .findOne({ level, active: true });
            if (!rewardConfig) return;

            // Check dynamic multiplier
            const mult = await db.collection('reward_multipliers')
                .findOne({ _id: 'skills' } as any);
            const multiplier = mult?.active ? (mult.multiplier || 1) : 0;
            if (multiplier === 0) return;

            const amount = rewardConfig.reward_nut * multiplier;
            const skillKey = skillName.toLowerCase().replace(/\s/g, '');

            try {
                await db.collection('reward_queue').insertOne({
                    wallet,
                    achievement_id: `skill:${skillKey}:lv${level}`,
                    player_username: username,
                    amount,
                    status: 'pending',
                    created_at: new Date(),
                    processed_at: null,
                    tx_hash: null,
                    idempotency_key: `${wallet}:skill:${skillKey}:lv${level}`
                });
                log.info(`[Rewards] Queued ${amount} $NUT for ${username} (${skillName} lv${level})`);
            } catch (error: any) {
                if (error.code !== 11000)
                    log.error(`[Rewards] Failed to queue skill level reward: ${error.message}`);
            }
        }).catch((error) => {
            log.error(`[Rewards] Unexpected error in queueLevelReward: ${error.message}`);
        });
    }

    /**
     * Grabs a skill from our dictionary of skills based on its type.
     * @param type The skill type identifier to get.
     * @returns The instance of the skill if found, otherwise undefined.
     */

    public get(type: Modules.Skills): Skill {
        return this.skills[type];
    }

    /**
     * Gets the combat skills of the player and returns an array.
     * @returns An array of all the combat-related skills.
     */

    public getCombatSkills(): Skill[] {
        return Object.values(this.skills).filter((skill: Skill) => skill.combat);
    }

    /**
     * Shortcut function for grabbing the lumberjacking instance.
     * @returns The lumberjacking class instance.
     */

    public getLumberjacking(): Lumberjacking {
        return this.lumberjacking;
    }

    /**
     * @returns The mining class instance.
     */

    public getMining(): Mining {
        return this.mining;
    }

    /**
     * @returns The fishing class instance.
     */

    public getFishing(): Fishing {
        return this.fishing;
    }

    /**
     * @returns The foraging class instance.
     */

    public getForaging(): Foraging {
        return this.foraging;
    }

    /**
     * Calculates the total combat level by adding up all the combat-related skill levels. We subtract 1 from
     * each skill in order to keep the combat level at 1 when the player has 1 in all combat skills.
     * @returns Number representing the total combat level.
     */

    public getCombatLevel(): number {
        let level = 1,
            skills = this.getCombatSkills();

        for (let skill of skills) level += skill.level - 1;

        return level;
    }

    /**
     * Iterates through all the skills and serializes their data.
     * The data is stored in an array so that it can be parsed.
     * @param includeLevel Whether to include the level in the serialized data.
     * @returns Array containing data for each skill (at each index).
     */

    public serialize(includeLevel = false): SerializedSkills {
        let skills: SkillData[] = [];

        this.forEachSkill((skill: Skill) => skills.push(skill.serialize(includeLevel)));

        return {
            skills,
            cheater: this.player.isCheater()
        };
    }

    /**
     * Iterates through all the skills and creates a callback.
     * @param callback Contains skill being iterated currently.
     */

    public forEachSkill(callback: (skill: Skill) => void): void {
        for (let skill of Object.values(this.skills)) callback(skill);
    }

    /**
     * Callback for when the skills are loaded from the database,
     * a batch data of skills is sent to the client.
     */

    public onLoaded(callback: () => void): void {
        this.loadCallback = callback;
    }
}
