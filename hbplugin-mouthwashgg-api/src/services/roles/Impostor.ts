import { PlayerData, PlayerDieEvent, Room } from "@skeldjs/hindenburg";
import { EnumValue, KeyCode, NumberValue, Palette } from "mouthwash-types";

import {
    BaseRole,
    EventListener,
    ListenerType,
    MouthwashRole,
    RoleAlignment,
    RoleObjective
} from "../../api";

import { ButtonFixedUpdateEvent } from "../../events";
import { AssetReference } from "../assets";
import { EmojiService } from "../emojis";
import { AnyKillDistance, DefaultRoomOptionName } from "../gameOptions";
import { Button } from "../hud";

const killDistanceToRange = {
    "Really Short": 0.5,
    "Short": 1,
    "Medium": 2,
    "Long": 3
};

@MouthwashRole("Impostor", RoleAlignment.Impostor, Palette.impostorRed, EmojiService.getEmoji("impostor"))
@RoleObjective("Sabotage and kill the crewmates")
export class Impostor extends BaseRole {
    protected _killRange: number;
    protected _killCooldown: number;
    protected _killTarget?: PlayerData<Room>;

    protected _killButton?: Button;
    protected _killButtonEnabled: boolean;

    constructor(player: PlayerData<Room>) {
        super(player);

        this._killRange = killDistanceToRange[this.api.gameOptions.gameOptions.get(DefaultRoomOptionName.ImpostorKillDistance)?.getValue<EnumValue<AnyKillDistance>>().selectedOption || "Short"];
        this._killCooldown = this.api.gameOptions.gameOptions.get(DefaultRoomOptionName.ImpostorKillCooldown)?.getValue<NumberValue>().value || 45;

        this._killTarget = undefined;
        this._killButtonEnabled = true;
    }

    async markImpostor() {
        this.giveFakeTasks();
        this.player.info?.setImpostor(true);
    }

    async createKillButton() {
        this._killButton = await this.spawnButton(
            "kill-button",
            new AssetReference("PggResources/Global", "Assets/Mods/OfficialAssets/KillButton.png"),
            {
                maxTimer: this._killCooldown,
                currentTime: 10,
                isCountingDown: true,
                keys: [ KeyCode.Q ]
            }
        );

        this._killButton?.on("mwgg.button.click", ev => {
            if (!this._killButton || !this.isKillButtonEnabled() || this._killButton.currentTime > 0 || !this._killTarget || this.player.info?.isDead)
                return;

            if (this._killTarget.transform) {
                this.player.transform?.snapTo(this._killTarget.transform.position);
            }
            this.patchMurderPlayer(this._killTarget, this._killTarget);
            this._killTarget.control?.murderPlayer(this._killTarget);
            this._killButton.setCurrentTime(this._killButton.maxTimer);
        });
    }

    async onReady() {
        await this.markImpostor();
        await this.createKillButton();
    }

    getTarget(players: PlayerData<Room>[]) {
        if (!this._killButton) {
            return undefined;
        }

        if (this.player.physics && this.player.physics.ventid > -1) {
            return undefined;
        }

        return this._killButton.getNearestPlayer(players, this._killRange);
    }

    setKillButtonEnabled(enabled: boolean) {
        this._killButtonEnabled = enabled;
    }

    isKillButtonEnabled() {
        return this._killButtonEnabled;
    }

    @EventListener("mwgg.button.fixedupdate", ListenerType.Room)
    onButtonFixedUpdate(ev: ButtonFixedUpdateEvent) {
        if (!this._killButton)
            return;

        if (!this._killButtonEnabled) {
            this._killButton?.setSaturated(false);
            return;
        }

        const oldTarget = this._killTarget;
        this._killTarget = this.getTarget(ev.players);

        if (this._killTarget !== oldTarget) {
            if (oldTarget) {
                this.api.animationService.setOutlineFor(oldTarget, Palette.null, [ this.player ]);
            }
            if (this._killTarget) {
                this.api.animationService.setOutlineFor(this._killTarget, Palette.impostorRed, [ this.player ]);
            }
        }

        this._killButton?.setSaturated(!!this._killTarget);
    }
    
    @EventListener("player.die", ListenerType.Player)
    onPlayerDie(ev: PlayerDieEvent<Room>) {
        this._killButton?.destroy();
        this._killButton = undefined;
    }
}