import "@material/mwc-button/mwc-button";
import "@material/mwc-list/mwc-list-item";
import "@material/mwc-select/mwc-select";
import type { Select } from "@material/mwc-select/mwc-select";
import { TextField } from "@material/mwc-textfield/mwc-textfield";
import { mdiAlertCircle, mdiCheckCircle, mdiQrcodeScan } from "@mdi/js";
import "@polymer/paper-input/paper-input";
import type { PaperInputElement } from "@polymer/paper-input/paper-input";
import { UnsubscribeFunc } from "home-assistant-js-websocket";
import { css, CSSResultGroup, html, LitElement, TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators";
import type QrScanner from "qr-scanner";
import { fireEvent } from "../../../../../common/dom/fire_event";
import { stopPropagation } from "../../../../../common/dom/stop_propagation";
import "../../../../../components/ha-alert";
import { HaCheckbox } from "../../../../../components/ha-checkbox";
import "../../../../../components/ha-circular-progress";
import { createCloseHeading } from "../../../../../components/ha-dialog";
import "../../../../../components/ha-formfield";
import "../../../../../components/ha-radio";
import "../../../../../components/ha-switch";
import {
  grantSecurityClasses,
  InclusionStrategy,
  MINIMUM_QR_STRING_LENGTH,
  parseQrCode,
  provisionSmartStartNode,
  QRProvisioningInformation,
  RequestedGrant,
  SecurityClass,
  stopInclusion,
  subscribeAddNode,
  supportsFeature,
  validateDskAndEnterPin,
  ZWaveFeature,
} from "../../../../../data/zwave_js";
import { showAlertDialog } from "../../../../../dialogs/generic/show-dialog-box";
import { haStyle, haStyleDialog } from "../../../../../resources/styles";
import { HomeAssistant } from "../../../../../types";
import { ZWaveJSAddNodeDialogParams } from "./show-dialog-zwave_js-add-node";

export interface ZWaveJSAddNodeDevice {
  id: string;
  name: string;
}

@customElement("dialog-zwave_js-add-node")
class DialogZWaveJSAddNode extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private _entryId?: string;

  @state() private _status?:
    | "loading"
    | "started"
    | "choose_strategy"
    | "qr_scan"
    | "interviewing"
    | "failed"
    | "timed_out"
    | "finished"
    | "provisioned"
    | "validate_dsk_enter_pin"
    | "grant_security_classes";

  @state() private _device?: ZWaveJSAddNodeDevice;

  @state() private _stages?: string[];

  @state() private _inclusionStrategy?: InclusionStrategy;

  @state() private _dsk?: string;

  @state() private _error?: string;

  @state() private _requestedGrant?: RequestedGrant;

  @state() private _securityClasses: SecurityClass[] = [];

  @state() private _lowSecurity = false;

  @state() private _supportsSmartStart?: boolean;

  private _addNodeTimeoutHandle?: number;

  private _subscribed?: Promise<UnsubscribeFunc>;

  private _cameras?: QrScanner.Camera[];

  private _qrScanner?: QrScanner;

  private _qrProcessing = false;

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this._unsubscribe();
  }

  public async showDialog(params: ZWaveJSAddNodeDialogParams): Promise<void> {
    this._entryId = params.entry_id;
    this._status = "loading";
    this._checkSmartStartSupport();
    this._startInclusion();
  }

  @query("#pin-input") private _pinInput?: PaperInputElement;

  @query("video") private _videoEl?: HTMLVideoElement;

  protected render(): TemplateResult {
    if (!this._entryId) {
      return html``;
    }

    return html`
      <ha-dialog
        open
        @closed=${this.closeDialog}
        .heading=${createCloseHeading(
          this.hass,
          this.hass.localize("ui.panel.config.zwave_js.add_node.title")
        )}
      >
        ${this._status === "loading"
          ? html`<div style="display: flex; justify-content: center;">
              <ha-circular-progress size="large" active></ha-circular-progress>
            </div>`
          : this._status === "choose_strategy"
          ? html`<h3>Choose strategy</h3>
              <div class="flex-column">
                <ha-formfield
                  .label=${html`<b>Secure if possible</b>
                    <div class="secondary">
                      Requires user interaction during inclusion. Fast and
                      secure with S2 when supported. Fallback to legacy S0 or no
                      encryption when necessary.
                    </div>`}
                >
                  <ha-radio
                    name="strategy"
                    @change=${this._handleStrategyChange}
                    .value=${InclusionStrategy.Default}
                    .checked=${this._inclusionStrategy ===
                      InclusionStrategy.Default ||
                    this._inclusionStrategy === undefined}
                  >
                  </ha-radio>
                </ha-formfield>
                <ha-formfield
                  .label=${html`<b>Legacy Secure</b>
                    <div class="secondary">
                      Uses the older S0 security that is secure, but slow due to
                      a lot of overhead. Allows securely including S2 capable
                      devices which fail to be included with S2.
                    </div>`}
                >
                  <ha-radio
                    name="strategy"
                    @change=${this._handleStrategyChange}
                    .value=${InclusionStrategy.Security_S0}
                    .checked=${this._inclusionStrategy ===
                    InclusionStrategy.Security_S0}
                  >
                  </ha-radio>
                </ha-formfield>
                <ha-formfield
                  .label=${html`<b>Insecure</b>
                    <div class="secondary">Do not use encryption.</div>`}
                >
                  <ha-radio
                    name="strategy"
                    @change=${this._handleStrategyChange}
                    .value=${InclusionStrategy.Insecure}
                    .checked=${this._inclusionStrategy ===
                    InclusionStrategy.Insecure}
                  >
                  </ha-radio>
                </ha-formfield>
              </div>
              <mwc-button
                slot="primaryAction"
                @click=${this._startManualInclusion}
              >
                Search device
              </mwc-button>`
          : this._status === "qr_scan"
          ? html`${this._cameras && this._cameras.length > 1
                ? html`<mwc-select
                    .label=${this.hass.localize(
                      "ui.panel.config.zwave_js.add_node.select_camera"
                    )}
                    fixedMenuPosition
                    naturalMenuWidth
                    @closed=${stopPropagation}
                    @selected=${this._cameraChanged}
                  >
                    ${this._cameras!.map(
                      (camera) => html`
                        <mwc-list-item .value=${camera.id}
                          >${camera.label}</mwc-list-item
                        >
                      `
                    )}
                  </mwc-select>`
                : ""}
              ${this._error
                ? html`<ha-alert alert-type="error">${this._error}</ha-alert>`
                : ""}
              ${navigator.mediaDevices
                ? html`<div class="canvas-container"></div>
                    <video></video>`
                : html`<ha-alert alert-type="warning"
                    >${window.location.protocol !== "https:"
                      ? "You can only use your camera to scan a QR core when using HTTPS."
                      : "Your browser doesn't support QR scanning."}</ha-alert
                  >`}
              <p>
                If scanning doesn't work, you can enter the QR code value
                manually:
              </p>
              <mwc-textfield
                .label=${this.hass.localize(
                  "ui.panel.config.zwave_js.add_node.enter_qr_code"
                )}
                @keydown=${this._qrKeyDown}
              ></mwc-textfield>`
          : this._status === "validate_dsk_enter_pin"
          ? html`
                <p>
                  Please enter the 5-digit PIN for your device and verify that
                  the rest of the device-specific key matches the one that can
                  be found on your device or the manual.
                </p>
                ${
                  this._error
                    ? html`<ha-alert alert-type="error"
                        >${this._error}</ha-alert
                      >`
                    : ""
                }
                <div class="flex-container">
                <paper-input
                  label="PIN"
                  id="pin-input"
                  @keyup=${this._handlePinKeyUp}
                  no-label-float
                ></paper-input>
                ${this._dsk}
                </div>
                <mwc-button
                  slot="primaryAction"
                  @click=${this._validateDskAndEnterPin}
                >
                  Submit
                </mwc-button>
              </div>
            `
          : this._status === "grant_security_classes"
          ? html`
              <h3>The device has requested the following security classes:</h3>
              ${this._error
                ? html`<ha-alert alert-type="error">${this._error}</ha-alert>`
                : ""}
              <div class="flex-column">
                ${this._requestedGrant?.securityClasses
                  .sort()
                  .reverse()
                  .map(
                    (securityClass) => html`<ha-formfield
                      .label=${html`<b
                          >${this.hass.localize(
                            `ui.panel.config.zwave_js.security_classes.${SecurityClass[securityClass]}.title`
                          )}</b
                        >
                        <div class="secondary">
                          ${this.hass.localize(
                            `ui.panel.config.zwave_js.security_classes.${SecurityClass[securityClass]}.description`
                          )}
                        </div>`}
                    >
                      <ha-checkbox
                        @change=${this._handleSecurityClassChange}
                        .value=${securityClass}
                        .checked=${this._securityClasses.includes(
                          securityClass
                        )}
                      >
                      </ha-checkbox>
                    </ha-formfield>`
                  )}
              </div>
              <mwc-button
                slot="primaryAction"
                .disabled=${!this._securityClasses.length}
                @click=${this._grantSecurityClasses}
              >
                Submit
              </mwc-button>
            `
          : this._status === "timed_out"
          ? html`
              <h3>Timed out!</h3>
              <p>
                We have not found any device in inclusion mode. Make sure the
                device is active and in inclusion mode.
              </p>
              <mwc-button slot="primaryAction" @click=${this._startInclusion}>
                Retry
              </mwc-button>
            `
          : this._status === "started"
          ? html`
              <div class="select-inclusion">
                <div class="outline">
                  <h2>
                    ${this.hass.localize(
                      "ui.panel.config.zwave_js.add_node.searching_device"
                    )}
                  </h2>
                  <ha-circular-progress active></ha-circular-progress>
                  <p>
                    ${this.hass.localize(
                      "ui.panel.config.zwave_js.add_node.follow_device_instructions"
                    )}
                  </p>
                  <p>
                    <button
                      class="link"
                      @click=${this._chooseInclusionStrategy}
                    >
                      ${this.hass.localize(
                        "ui.panel.config.zwave_js.add_node.choose_inclusion_strategy"
                      )}
                    </button>
                  </p>
                </div>
                ${this._supportsSmartStart
                  ? html` <div class="outline">
                      <h2>
                        ${this.hass.localize(
                          "ui.panel.config.zwave_js.add_node.qr_code"
                        )}
                      </h2>
                      <ha-svg-icon .path=${mdiQrcodeScan}></ha-svg-icon>
                      <p>
                        ${this.hass.localize(
                          "ui.panel.config.zwave_js.add_node.qr_code_paragraph"
                        )}
                      </p>
                      <p>
                        <mwc-button @click=${this._scanQRCode}>
                          ${this.hass.localize(
                            "ui.panel.config.zwave_js.add_node.scan_qr_code"
                          )}
                        </mwc-button>
                      </p>
                    </div>`
                  : ""}
              </div>
              <mwc-button slot="primaryAction" @click=${this.closeDialog}>
                ${this.hass.localize(
                  "ui.panel.config.zwave_js.add_node.cancel_inclusion"
                )}
              </mwc-button>
            `
          : this._status === "interviewing"
          ? html`
              <div class="flex-container">
                <ha-circular-progress active></ha-circular-progress>
                <div class="status">
                  <p>
                    <b
                      >${this.hass.localize(
                        "ui.panel.config.zwave_js.add_node.interview_started"
                      )}</b
                    >
                  </p>
                  ${this._stages
                    ? html` <div class="stages">
                        ${this._stages.map(
                          (stage) => html`
                            <span class="stage">
                              <ha-svg-icon
                                .path=${mdiCheckCircle}
                                class="success"
                              ></ha-svg-icon>
                              ${stage}
                            </span>
                          `
                        )}
                      </div>`
                    : ""}
                </div>
              </div>
              <mwc-button slot="primaryAction" @click=${this.closeDialog}>
                ${this.hass.localize("ui.panel.config.zwave_js.common.close")}
              </mwc-button>
            `
          : this._status === "failed"
          ? html`
              <div class="flex-container">
                <div class="status">
                  <ha-alert
                    alert-type="error"
                    .title=${this.hass.localize(
                      "ui.panel.config.zwave_js.add_node.inclusion_failed"
                    )}
                  >
                    ${this._error ||
                    this.hass.localize(
                      "ui.panel.config.zwave_js.add_node.check_logs"
                    )}
                  </ha-alert>
                  ${this._stages
                    ? html` <div class="stages">
                        ${this._stages.map(
                          (stage) => html`
                            <span class="stage">
                              <ha-svg-icon
                                .path=${mdiCheckCircle}
                                class="success"
                              ></ha-svg-icon>
                              ${stage}
                            </span>
                          `
                        )}
                      </div>`
                    : ""}
                </div>
              </div>
              <mwc-button slot="primaryAction" @click=${this.closeDialog}>
                ${this.hass.localize("ui.panel.config.zwave_js.common.close")}
              </mwc-button>
            `
          : this._status === "finished"
          ? html`
              <div class="flex-container">
                <ha-svg-icon
                  .path=${this._lowSecurity ? mdiAlertCircle : mdiCheckCircle}
                  class=${this._lowSecurity ? "warning" : "success"}
                ></ha-svg-icon>
                <div class="status">
                  <p>
                    ${this.hass.localize(
                      "ui.panel.config.zwave_js.add_node.inclusion_finished"
                    )}
                  </p>
                  ${this._lowSecurity
                    ? html`<ha-alert
                        alert-type="warning"
                        title="The device was added insecurely"
                      >
                        There was an error during secure inclusion. You can try
                        again by excluding the device and adding it again.
                      </ha-alert>`
                    : ""}
                  <a href=${`/config/devices/device/${this._device!.id}`}>
                    <mwc-button>
                      ${this.hass.localize(
                        "ui.panel.config.zwave_js.add_node.view_device"
                      )}
                    </mwc-button>
                  </a>
                  ${this._stages
                    ? html` <div class="stages">
                        ${this._stages.map(
                          (stage) => html`
                            <span class="stage">
                              <ha-svg-icon
                                .path=${mdiCheckCircle}
                                class="success"
                              ></ha-svg-icon>
                              ${stage}
                            </span>
                          `
                        )}
                      </div>`
                    : ""}
                </div>
              </div>
              <mwc-button slot="primaryAction" @click=${this.closeDialog}>
                ${this.hass.localize("ui.panel.config.zwave_js.common.close")}
              </mwc-button>
            `
          : this._status === "provisioned"
          ? html` <div class="flex-container">
                <ha-svg-icon
                  .path=${mdiCheckCircle}
                  class="success"
                ></ha-svg-icon>
                <div class="status">
                  <p>
                    ${this.hass.localize(
                      "ui.panel.config.zwave_js.add_node.provisioning_finished"
                    )}
                  </p>
                </div>
              </div>
              <mwc-button slot="primaryAction" @click=${this.closeDialog}>
                ${this.hass.localize("ui.panel.config.zwave_js.common.close")}
              </mwc-button>`
          : ""}
      </ha-dialog>
    `;
  }

  private _chooseInclusionStrategy(): void {
    this._unsubscribe();
    this._status = "choose_strategy";
  }

  private _handleStrategyChange(ev: CustomEvent): void {
    this._inclusionStrategy = (ev.target as any).value;
  }

  private _handleSecurityClassChange(ev: CustomEvent): void {
    const checkbox = ev.currentTarget as HaCheckbox;
    const securityClass = Number(checkbox.value);
    if (checkbox.checked && !this._securityClasses.includes(securityClass)) {
      this._securityClasses = [...this._securityClasses, securityClass];
    } else if (!checkbox.checked) {
      this._securityClasses = this._securityClasses.filter(
        (val) => val !== securityClass
      );
    }
  }

  private async _scanQRCode(): Promise<void> {
    this._unsubscribe();
    this._status = "loading";
    if (navigator.mediaDevices) {
      const QrScanner = (await import("qr-scanner")).default;
      if (!(await QrScanner.hasCamera())) {
        await showAlertDialog(this, { title: "No camera found" });
        this._startInclusion();
        return;
      }
      QrScanner.WORKER_PATH = "/static/js/qr-scanner-worker.min.js";
      this._cameras = await QrScanner.listCameras(true);
      this._status = "qr_scan";
      await this.updateComplete;
      this._qrScanner = new QrScanner(this._videoEl!, this._qrCodeScanned);
      try {
        await this._qrScanner.start();
      } catch (err: any) {
        this._error = err;
        return;
      }
      this.shadowRoot
        ?.querySelector(".canvas-container")
        // @ts-ignore
        ?.appendChild(this._qrScanner.$canvas);
      // @ts-ignore
      this._qrScanner.$canvas.style.display = "block";
    } else {
      this._status = "qr_scan";
    }
  }

  private _qrKeyDown(ev: KeyboardEvent) {
    if (ev.key === "Enter") {
      this._qrCodeScanned((ev.target as TextField).value);
    }
  }

  private _qrCodeScanned = async (qrCodeString: string): Promise<void> => {
    this._error = undefined;
    if (this._qrProcessing) {
      return;
    }
    this._qrProcessing = true;
    if (
      qrCodeString.length < MINIMUM_QR_STRING_LENGTH ||
      !qrCodeString.startsWith("90")
    ) {
      this._qrProcessing = false;
      this._error = `Invalid QR code (${qrCodeString})`;
      return;
    }
    let provisioningInfo: QRProvisioningInformation;
    try {
      provisioningInfo = await parseQrCode(
        this.hass,
        this._entryId!,
        qrCodeString
      );
    } catch (err: any) {
      this._qrProcessing = false;
      this._error = err.message;
      return;
    }
    this._qrScanner!.stop();
    this._qrScanner!.destroy();
    this._qrScanner = undefined;
    this._qrProcessing = false;
    this._status = "loading";
    try {
      await provisionSmartStartNode(
        this.hass,
        this._entryId!,
        undefined,
        provisioningInfo
      );
      this._status = "provisioned";
    } catch (err: any) {
      this._error = err.message;
      this._status = "failed";
    }
  };

  private _cameraChanged(ev: CustomEvent): void {
    this._qrScanner?.setCamera((ev.target as Select).value);
  }

  private _handlePinKeyUp(ev: KeyboardEvent) {
    if (ev.key === "Enter") {
      this._validateDskAndEnterPin();
    }
  }

  private async _validateDskAndEnterPin(): Promise<void> {
    this._status = "loading";
    this._error = undefined;
    try {
      await validateDskAndEnterPin(
        this.hass,
        this._entryId!,
        this._pinInput!.value as string
      );
    } catch (err: any) {
      this._error = err.message;
      this._status = "validate_dsk_enter_pin";
    }
  }

  private async _grantSecurityClasses(): Promise<void> {
    this._status = "loading";
    this._error = undefined;
    try {
      await grantSecurityClasses(
        this.hass,
        this._entryId!,
        this._securityClasses
      );
    } catch (err: any) {
      this._error = err.message;
      this._status = "grant_security_classes";
    }
  }

  private _startManualInclusion() {
    if (!this._inclusionStrategy) {
      this._inclusionStrategy = InclusionStrategy.Default;
    }
    this._startInclusion();
  }

  private async _checkSmartStartSupport() {
    this._supportsSmartStart = (
      await supportsFeature(this.hass, this._entryId!, ZWaveFeature.SmartStart)
    ).supported;
    this._supportsSmartStart = true;
  }

  private _startInclusion(): void {
    if (!this.hass) {
      return;
    }
    this._lowSecurity = false;
    this._subscribed = subscribeAddNode(
      this.hass,
      this._entryId!,
      (message) => {
        if (message.event === "inclusion started") {
          this._status = "started";
        }
        if (message.event === "inclusion failed") {
          this._unsubscribe();
          this._status = "failed";
        }
        if (message.event === "inclusion stopped") {
          // We either found a device, or it failed, either way, cancel the timeout as we are no longer searching
          if (this._addNodeTimeoutHandle) {
            clearTimeout(this._addNodeTimeoutHandle);
          }
          this._addNodeTimeoutHandle = undefined;
        }

        if (message.event === "validate dsk and enter pin") {
          this._status = "validate_dsk_enter_pin";
          this._dsk = message.dsk;
        }

        if (message.event === "grant security classes") {
          if (this._inclusionStrategy === undefined) {
            grantSecurityClasses(
              this.hass,
              this._entryId!,
              message.requested_grant.securityClasses,
              message.requested_grant.clientSideAuth
            );
            return;
          }
          this._requestedGrant = message.requested_grant;
          this._securityClasses = message.requested_grant.securityClasses;
          this._status = "grant_security_classes";
        }

        if (message.event === "device registered") {
          this._device = message.device;
        }
        if (message.event === "node added") {
          this._status = "interviewing";
          this._lowSecurity = message.node.low_security;
        }

        if (message.event === "interview completed") {
          this._unsubscribe();
          this._status = "finished";
        }

        if (message.event === "interview stage completed") {
          if (this._stages === undefined) {
            this._stages = [message.stage];
          } else {
            this._stages = [...this._stages, message.stage];
          }
        }
      },
      this._inclusionStrategy
    );
    this._addNodeTimeoutHandle = window.setTimeout(() => {
      this._unsubscribe();
      this._status = "timed_out";
    }, 90000);
  }

  private _unsubscribe(): void {
    if (this._subscribed) {
      this._subscribed.then((unsub) => unsub());
      this._subscribed = undefined;
    }
    if (this._entryId) {
      stopInclusion(this.hass, this._entryId);
    }
    this._requestedGrant = undefined;
    this._dsk = undefined;
    this._securityClasses = [];
    this._status = undefined;
    if (this._addNodeTimeoutHandle) {
      clearTimeout(this._addNodeTimeoutHandle);
    }
    this._addNodeTimeoutHandle = undefined;
  }

  public closeDialog(): void {
    this._unsubscribe();
    this._inclusionStrategy = undefined;
    this._entryId = undefined;
    this._status = undefined;
    this._device = undefined;
    this._stages = undefined;
    this._error = undefined;
    if (this._qrScanner) {
      this._qrScanner.stop();
      this._qrScanner.destroy();
      this._qrScanner = undefined;
    }
    fireEvent(this, "dialog-closed", { dialog: this.localName });
  }

  static get styles(): CSSResultGroup {
    return [
      haStyleDialog,
      haStyle,
      css`
        h3 {
          margin-top: 0;
        }

        .success {
          color: var(--success-color);
        }

        .warning {
          color: var(--warning-color);
        }

        .stages {
          margin-top: 16px;
          display: grid;
        }

        .flex-container .stage ha-svg-icon {
          width: 16px;
          height: 16px;
          margin-right: 0px;
        }
        .stage {
          padding: 8px;
        }

        .flex-container {
          display: flex;
          align-items: center;
        }

        .flex-column {
          display: flex;
          flex-direction: column;
        }

        .flex-column ha-formfield {
          padding: 8px 0;
        }

        .select-inclusion {
          display: flex;
          align-items: center;
        }

        .select-inclusion .outline:nth-child(2) {
          margin-left: 16px;
        }

        .select-inclusion .outline {
          border: 1px solid var(--divider-color);
          border-radius: 4px;
          padding: 16px;
          min-height: 250px;
          text-align: center;
          flex: 1;
        }

        @media all and (max-width: 500px) {
          .select-inclusion {
            flex-direction: column;
          }

          .select-inclusion .outline:nth-child(2) {
            margin-left: 0;
            margin-top: 16px;
          }
        }

        canvas {
          width: 100%;
        }

        mwc-select {
          width: 100%;
          margin-bottom: 16px;
        }

        mwc-textfield {
          width: 100%;
        }

        ha-svg-icon {
          width: 68px;
          height: 48px;
        }
        .secondary {
          color: var(--secondary-text-color);
        }

        .flex-container ha-circular-progress,
        .flex-container ha-svg-icon {
          margin-right: 20px;
        }
      `,
    ];
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dialog-zwave_js-add-node": DialogZWaveJSAddNode;
  }
}
