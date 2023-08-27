import * as crypto from "crypto";

import {
    Connection,
    HindenburgPlugin,
    MessageHandler,
    MessageHandlerCallback,
    PacketContext,
    PlayerData,
    Room,
    RoomGameEndEvent,
    RoomPlugin,
    RpcMessage,
    SpawnType,
    SyncSettingsMessage,
    EventListener,
    RoomDestroyEvent,
    BaseRpcMessage,
    AddVoteMessage,
    CastVoteMessage,
    CheckColorMessage,
    CheckNameMessage,
    ClearVoteMessage,
    ClimbLadderMessage,
    CloseMessage,
    CloseDoorsOfTypeMessage,
    CompleteTaskMessage,
    EnterVentMessage,
    ExiledMessage,
    ExitVentMessage,
    MurderPlayerMessage,
    PlayAnimationMessage,
    RepairSystemMessage,
    SendChatMessage,
    SendChatNoteMessage,
    SetColorMessage,
    SetHatMessage,
    RpcMessageTag,
    SendQuickChatMessage,
    SetInfectedMessage,
    SetNameMessage,
    SetPetMessage,
    SetScanner,
    SetStartCounterMessage,
    SetTasksMessage,
    SnapToMessage,
    StartMeetingMessage,
    UpdateSystemMessage,
    UsePlatformMessage,
    VotingCompleteMessage,
    Color,
    AirshipStatus,
    Networkable,
    PlayerControl,
    PlayerPhysics,
    CustomNetworkTransform,
    InnerShipStatus,
    SetSkinMessage,
    Pet,
    Hat,
    Skin
} from "@skeldjs/hindenburg";

import { MouthwashApiPlugin, RoleCtr } from "hbplugin-mouthwashgg-api";
import { MouthwashggMetricsPlugin } from "hbplugin-mouthwashgg-metrics";

import { CollidersService } from "./Colliders";
import { InfractionName } from "./enums";
import { MouthwashAuthPlugin } from "hbplugin-mouthwashgg-auth";
import { getAnticheatExceptions } from "./hooks";

export enum InfractionSeverity {
    Low = "LOW",
    Medium = "MEDIUM",
    High = "HIGH",
    Critical = "CRITICAL"
}

export interface PlayerInfraction {
    userId: string|null;
    gameId: string|null;
    createdAt: Date;
    playerPing: number;
    infractionName: string;
    additionalDetails: any;
    severity: InfractionSeverity;
}

@HindenburgPlugin("hbplugin-mouthwashgg-anti-cheat", "1.0.0", "last")
export class MouthwashAntiCheatPlugin extends RoomPlugin {
    collidersService: CollidersService;
    api!: MouthwashApiPlugin;
    authApi: MouthwashAuthPlugin;

    metrics?: MouthwashggMetricsPlugin;
    unflushedPlayerInfractions: PlayerInfraction[];

    constructor(
        public readonly room: Room,
        public readonly config: any
    ) {
        super(room, config);

        this.collidersService = new CollidersService(this);
        this.metrics = this.getDependencyUnsafe("hbplugin-mouthwashgg-metrics", "worker") as MouthwashggMetricsPlugin|undefined;
        this.authApi = this.assertDependency("hbplugin-mouthwashgg-auth", "worker") as MouthwashAuthPlugin;
        this.api = this.assertDependency("hbplugin-mouthwashgg-api", "room") as MouthwashApiPlugin;
        this.unflushedPlayerInfractions = [];
    }

    async onPluginLoad() {
        await this.collidersService.loadAllColliders();
        this.logger.info("Loaded colliders for maps");
    }

    // async banPlayer(player: PlayerData<Room>|Connection, role: BaseRole|undefined, reason: AnticheatReason) {
    //     const connection = player instanceof Connection ? player : this.room.connections.get(player.clientId);
    //     if (!connection) return;

    //     this.room.bannedAddresses.add(connection.remoteInfo.address);
    //     if (!role) {
    //         this.logger.info("Banned %s for reason '%s'",
    //             player, reason);
    //     } else {
    //         this.logger.info("Banned %s for reason '%s' (role %s, %s)",
    //             player, reason, role.metadata.roleName, RoleAlignment[role.metadata.alignment]);
    //     }
    //     connection.disconnect(DisconnectReason.Banned);
    // }

    async flushPlayerInfractions() {
        const lobbyId = this.metrics?.lobbyIds.get(this.room);
        if (this.unflushedPlayerInfractions.length === 0) {
            this.logger.info("No infractions to flush");
            return;
        }

        if (this.metrics === undefined) {
            this.logger.warn("No metrics plugin to flush infractions to, please ensure that the plugin is loaded alongside this one");
            return;
        }

        const params = [];
        for (const playerInfraction of this.unflushedPlayerInfractions) {
            params.push(crypto.randomUUID(), playerInfraction.userId, lobbyId || null, playerInfraction.gameId, playerInfraction.createdAt,
                playerInfraction.playerPing, playerInfraction.infractionName, playerInfraction.additionalDetails, playerInfraction.severity);
        }
        const { rows: addedInfractions } = await this.metrics?.postgresClient.query(`
            INSERT INTO player_infraction(id, user_id, lobby_id, game_id, created_at, player_ping, infraction_name, additional_details, severity)
            VALUES ${this.unflushedPlayerInfractions.map((_uploadLobbiesInterval, i) =>
                `($${(i * 9) + 1}, $${(i * 9) + 2}, $${(i * 9) + 3}, $${(i * 9) + 4}, $${(i * 9) + 5}, $${(i * 9) + 6}, $${(i * 9) + 7}, $${(i * 9) + 8}, $${(i * 9) + 9})`)
                .join(",")}
            RETURNING *
        `, params);
        this.logger.info("Flushed %s/%s infractions", addedInfractions.length, this.unflushedPlayerInfractions.length);
        this.unflushedPlayerInfractions = [];
    }

    async createInfraction(playerOrConnection: PlayerData<Room>|Connection, infractionName: InfractionName, additionalDetails: any, severity: InfractionSeverity) {
        const gameId = this.metrics?.lobbyCurrentGameIds.get(this.room);
        const connection = playerOrConnection instanceof Connection ? playerOrConnection : this.room.getConnection(playerOrConnection);
        const player = playerOrConnection instanceof PlayerData ? playerOrConnection : playerOrConnection.getPlayer();
        if (!connection) {
            this.logger.warn("Tried to log infraction %s (%s) for %s, but they didn't have a connection on the server",
                infractionName, severity, player);
            return;
        }
        if (!player) {
            this.logger.warn("Tried to log infraction %s (%s) for %s, but they didn't have a player in the room",
                infractionName, severity, player);
            return;
        }
        const playerRole = this.api.roleService.getPlayerRole(player);
        if (playerRole !== undefined) {
            const exceptions = getAnticheatExceptions(playerRole["constructor"] as RoleCtr);
            if (exceptions.has(infractionName)) {
                return;
            }
        }

        const connectionUser = await this.authApi.getConnectionUser(connection);
        if (!connectionUser) {
            this.logger.warn("Tried to log infraction %s (%s) for %s, but they don't appear to be logged in",
                infractionName, severity, player);
            return;
        }

        const infraction: PlayerInfraction = {
            userId: connectionUser.id,
            gameId: gameId || null,
            createdAt: new Date,
            playerPing: connection.roundTripPing,
            infractionName,
            additionalDetails,
            severity
        };

        this.unflushedPlayerInfractions.push(infraction);

        if (severity !== "LOW") {
            this.logger.warn("Player %s violated infraction rule %s (%s unflushed infraction%s)",
                player, infractionName, this.unflushedPlayerInfractions.length, this.unflushedPlayerInfractions.length === 1 ? "" : "s");
            return infraction;
        }

        if (this.unflushedPlayerInfractions.length > 100) {
            this.flushPlayerInfractions();
        }
        
        return infraction;
    }

    async onRpcMessageData(component: Networkable, rpcMessage: BaseRpcMessage, sender: Connection) {
        switch (rpcMessage.messageTag) {
        case RpcMessageTag.AddVote:
            // TODO: used for votebansystem - do we even have this?
            // const addVoteMessage = rpcMessage as AddVoteMessage;
            // return this.createInfraction(sender, InfractionName.InvalidRpcColor, { rpcId: RpcMessageTag.AddVote }, InfractionSeverity.Critical);
        case RpcMessageTag.CastVote:
            const castVoteMessage = rpcMessage as CastVoteMessage;
            const castVoteVoter = this.room.getPlayerByPlayerId(castVoteMessage.votingid);
            const castVoteSuspect = this.room.getPlayerByPlayerId(castVoteMessage.suspectid);
            if (!castVoteVoter)
                return this.createInfraction(sender, InfractionName.ForbiddenRpcMeetingVote,
                    { voterPlayerId: castVoteMessage.votingid, suspectPlayerId: castVoteMessage.suspectid }, InfractionSeverity.High);

            if (castVoteVoter.clientId !== sender.clientId)
                return this.createInfraction(sender, InfractionName.ForbiddenRpcMeetingVote,
                    { voterPlayerId: castVoteMessage.votingid, suspectPlayerId: castVoteMessage.suspectid }, InfractionSeverity.Critical);

            const voterState = this.room.meetingHud?.voteStates.get(castVoteMessage.votingid);
            if (!voterState) return;

            if (voterState.hasVoted) {
                return this.createInfraction(sender, InfractionName.DuplicateRpcMeetingVote,
                    { voterPlayerId: castVoteMessage.votingid, suspectPlayerId: castVoteMessage.suspectid, alreadyVotedForPlayerId: voterState.votedForId }, InfractionSeverity.High);
            }

            if (castVoteSuspect) {
                if (castVoteSuspect.info?.isDead) {
                    return this.createInfraction(sender, InfractionName.InvalidRpcMeetingVote,
                        { voterPlayerId: castVoteMessage.votingid, suspectPlayerId: castVoteMessage.suspectid, isDead: true }, InfractionSeverity.High);
                }
            } else if (castVoteMessage.suspectid !== 255) {
                return this.createInfraction(sender, InfractionName.InvalidRpcMeetingVote,
                    { voterPlayerId: castVoteMessage.votingid, suspectPlayerId: castVoteMessage.suspectid, isDead: false },  InfractionSeverity.High);
            }
            break;
        case RpcMessageTag.CheckColor:
            const checkColorMessage = rpcMessage as CheckColorMessage;
            if (!(checkColorMessage.color in Color))
                return this.createInfraction(sender, InfractionName.InvalidRpcColor,
                    { colorId: checkColorMessage.color },  InfractionSeverity.Critical);
            break;
        case RpcMessageTag.CheckName:
            const checkNameMessage = rpcMessage as CheckNameMessage;
            const checkNameConnectionUser = await this.authApi.getConnectionUser(sender);
            if (!checkNameConnectionUser) return;
            if (checkNameMessage.name !== checkNameConnectionUser.display_name) {
                return this.createInfraction(sender, InfractionName.InvalidRpcName,
                    { name: checkNameMessage.name },  InfractionSeverity.Critical);
            }
            break;
        case RpcMessageTag.ClearVote:
        case RpcMessageTag.Close:
        case RpcMessageTag.Exiled:
        case RpcMessageTag.MurderPlayer:
        case RpcMessageTag.PlayAnimation:
        case RpcMessageTag.ReportDeadBody:
        case RpcMessageTag.SetInfected:
        case RpcMessageTag.SetTasks:
        case RpcMessageTag.SetName:
        case RpcMessageTag.SetColor:
        case RpcMessageTag.StartMeeting:
        case RpcMessageTag.SyncSettings:
        case RpcMessageTag.VotingComplete:
        case RpcMessageTag.BootFromVent:
            return this.createInfraction(sender, InfractionName.ForbiddenRpcCode, { netId: component.netId, rpcId: rpcMessage.messageTag, spawnType: component.spawnType }, InfractionSeverity.Critical);
        case RpcMessageTag.ClimbLadder:
            const climbLadderMessage = rpcMessage as ClimbLadderMessage;
            break;
        case RpcMessageTag.CloseDoorsOfType:
            const closeDoorsOfTypeMessage = rpcMessage as CloseDoorsOfTypeMessage;
            break;
        case RpcMessageTag.CompleteTask:
            const completeTaskMessage = rpcMessage as CompleteTaskMessage;
            break;
        case RpcMessageTag.EnterVent:
            const enterVentMessage = rpcMessage as EnterVentMessage;
            return this.createInfraction(sender, InfractionName.ForbiddenRpcVent, { ventId: enterVentMessage.ventid }, InfractionSeverity.High);
        case RpcMessageTag.ExitVent:
            const exitVentMessage = rpcMessage as ExitVentMessage;
            return this.createInfraction(sender, InfractionName.ForbiddenRpcVent, { ventId: exitVentMessage.ventid }, InfractionSeverity.High);
        case RpcMessageTag.MurderPlayer: // Murders are replaced by button presses
            const murderPlayerMessage = rpcMessage as MurderPlayerMessage;
        case RpcMessageTag.RepairSystem:
            const repairSystemMessage = rpcMessage as RepairSystemMessage;
            break;
        case RpcMessageTag.SendChat:
            const sendChatMessage = rpcMessage as SendChatMessage;
            break;
        case RpcMessageTag.SendChatNote:
            const sendChatNoteMessage = rpcMessage as SendChatNoteMessage;
            break;
        case RpcMessageTag.SendQuickChat:
            const sendQuickChatMessage = rpcMessage as SendQuickChatMessage;
            break;
        case RpcMessageTag.SetHat:
            const setHatMessage = rpcMessage as SetHatMessage;
            if (setHatMessage.hat === 9999999 as Hat) return;
            const setHatConnectionUser = await this.authApi.getConnectionUser(sender);
            if (setHatConnectionUser) {
                if (!(setHatMessage.hat in Hat) && setHatConnectionUser.owned_cosmetics.findIndex(cosmetic => cosmetic.among_us_id === setHatMessage.hat && cosmetic.type === "HAT") === -1) {
                    return this.createInfraction(sender, InfractionName.InvalidRpcHat, { hatId: setHatMessage.hat }, InfractionSeverity.Critical);
                }
            }
        case RpcMessageTag.SetPet:
            const setPetMessage = rpcMessage as SetPetMessage;
            if (setPetMessage.pet === 9999999 as Pet) return;
            const setPetConnectionUser = await this.authApi.getConnectionUser(sender);
            if (!setPetConnectionUser) return;
            if (setPetConnectionUser) {
                if (!(setPetMessage.pet in Pet) && setPetConnectionUser.owned_cosmetics.findIndex(cosmetic => cosmetic.among_us_id === setPetMessage.pet && cosmetic.type === "PET") === -1) {
                    return this.createInfraction(sender, InfractionName.InvalidRpcPet, { petId: setPetMessage.pet }, InfractionSeverity.Critical);
                }
            }
        case RpcMessageTag.SetSkin:
            const setSkinMessage = rpcMessage as SetSkinMessage;
            if (setSkinMessage.skin === 9999999 as Skin) return;
            if (!(setSkinMessage.skin in Skin)) {
                return this.createInfraction(sender, InfractionName.InvalidRpcSkin, { skinId: setSkinMessage.skin }, InfractionSeverity.Critical);
            }
        case RpcMessageTag.SetScanner:
            const setScannerMessage = rpcMessage as SetScanner;
            break;
        case RpcMessageTag.SetStartCounter:
            const setStartCounterMessage = rpcMessage as SetStartCounterMessage;
            if (this.room.actingHostsEnabled && !this.room.actingHostIds.has(sender.clientId)) {
                return this.createInfraction(sender, InfractionName.ForbiddenRpcCode, { netId: component.netId, rpcId: rpcMessage.messageTag, spawnType: component.spawnType }, InfractionSeverity.Critical);
            }
            break;
        case RpcMessageTag.SnapTo:
            if (!(this.room.shipStatus instanceof AirshipStatus)) {
                return this.createInfraction(sender, InfractionName.ForbiddenRpcCode, { netId: component.netId, rpcId: RpcMessageTag.SnapTo, spawnType: component.spawnType }, InfractionSeverity.Critical);
            }
            break;
        case RpcMessageTag.UpdateSystem:
            const updateSystemMessage = rpcMessage as UpdateSystemMessage;
            break;
        case RpcMessageTag.UsePlatform:
            const usePlatformMessage = rpcMessage as UsePlatformMessage;
            break;
        default:
            return this.createInfraction(sender, InfractionName.InvalidRpcCode, { netId: component.netId, rpcId: rpcMessage.messageTag }, InfractionSeverity.High);
        }

        switch (rpcMessage.messageTag as RpcMessageTag) {
            case RpcMessageTag.AddVote:
                if (this.room.voteBanSystem === component) return;
                break;
            case RpcMessageTag.CastVote:
            case RpcMessageTag.ClearVote:
            case RpcMessageTag.Close:
            case RpcMessageTag.VotingComplete:
                if (this.room.meetingHud === component) return;
                break;
            case RpcMessageTag.CheckColor:
            case RpcMessageTag.CheckName:
            case RpcMessageTag.CompleteTask:
            case RpcMessageTag.Exiled:
            case RpcMessageTag.MurderPlayer:
            case RpcMessageTag.PlayAnimation:
            case RpcMessageTag.ReportDeadBody:
            case RpcMessageTag.SendChat:
            case RpcMessageTag.SendChatNote:
            case RpcMessageTag.SendQuickChat:
            case RpcMessageTag.SetColor:
            case RpcMessageTag.SetHat:
            case RpcMessageTag.SetInfected:
            case RpcMessageTag.SetName:
            case RpcMessageTag.SetPet:
            case RpcMessageTag.SetScanner:
            case RpcMessageTag.SetSkin:
            case RpcMessageTag.SetStartCounter:
            case RpcMessageTag.SetTasks:
            case RpcMessageTag.StartMeeting:
            case RpcMessageTag.SyncSettings:
            case RpcMessageTag.UsePlatform:
                if (component instanceof PlayerControl) return;
                break;
            case RpcMessageTag.ClimbLadder:
            case RpcMessageTag.EnterVent:
            case RpcMessageTag.ExitVent:
                if (component instanceof PlayerPhysics) return;
                break;
            case RpcMessageTag.SnapTo:
                if (component instanceof CustomNetworkTransform) return;
                break;
            case RpcMessageTag.RepairSystem:
            case RpcMessageTag.CloseDoorsOfType:
                if (this.room.shipStatus === component) return;
                break;
        }
        return this.createInfraction(sender, InfractionName.ForbiddenRpcCode, { netId: component.netId, rpcId: rpcMessage.messageTag, spawnType: component.spawnType }, InfractionSeverity.Critical);
    }

    @MessageHandler(RpcMessage, { override: true })
    async onRpcMessage(message: RpcMessage, context: PacketContext, originalHandlers: MessageHandlerCallback<RpcMessage>[]) {
        if (this.room.host && this.room.host.clientId === context.sender?.clientId && !this.room["finishedActingHostTransactionRoutine"] && message.data instanceof SyncSettingsMessage) {
            this.logger.info("Got initial settings, acting host handshake complete");
            this.room["finishedActingHostTransactionRoutine"] = true;
            this.room.settings.patch(message.data.settings);
            return;
        }

        const component = this.room.netobjects.get(message.netid);
        if (component) {
            if (context.sender) {
                if (component.ownerId === -1 || component.ownerId !== context.sender.clientId) {
                    this.createInfraction(context.sender, InfractionName.ForbiddenRpcInnernetObject, { netId: message.netid, rpcId: message.data.messageTag }, InfractionSeverity.Critical);
                    return;
                }

                const infraction = await this.onRpcMessageData(component, message.data, context.sender);
                if (infraction && infraction.severity === InfractionSeverity.Critical) return;
            }

            try {
                await component.HandleRpc(message.data);
            } catch (e) {
                this.logger.error("Could not process remote procedure call from client %s (net id %s, %s): %s",
                    context.sender, component.netId, SpawnType[component.spawnType] || "Unknown", e);
            }
        } else {
            if (context.sender) {
                this.createInfraction(context.sender, InfractionName.UnknownRpcInnernetObject, { netId: message.netid, rpcId: message.data.messageTag }, InfractionSeverity.Medium);
            }
            this.logger.warn("Got remote procedure call for non-existent component: net id %s. There is a chance that a player is using this to communicate discreetly with another player", message.netid);
        }
    }

    @EventListener("room.gameend")
    async onRoomGameEnd(ev: RoomGameEndEvent<Room>) {
        await this.flushPlayerInfractions();
    }

    @EventListener("room.destroy")
    async onRoomDestroy(ev: RoomDestroyEvent) {
        await this.flushPlayerInfractions();
    }
}