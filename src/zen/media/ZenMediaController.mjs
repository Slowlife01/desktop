// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
{
  const lazy = {};
  XPCOMUtils.defineLazyPreferenceGetter(
    lazy,
    'RESPECT_PIP_DISABLED',
    'media.videocontrols.picture-in-picture.respect-disablePictureInPicture',
    true
  );

  class nsZenMediaController {
    mediaControlsContainer = null;
    mediaControlsTemplate = null;

    supportedKeys = ['playpause', 'previoustrack', 'nexttrack'];
    mediaControllersMap = new Map();

    _tabTimeout = null;
    _controllerSwitchTimeout = null;

    _mediaControllers = new Map();
    _mediaUpdateIntervals = new Map();

    _lastUpdatedPositionTime = 0;
    _positionStates = {};

    init() {
      if (!Services.prefs.getBoolPref('zen.mediacontrols.enabled', true)) return;

      this.mediaControlsContainer = document.getElementById('zen-media-controls-container');
      this.mediaControlsTemplate = document.getElementById('zen-media-controls-template');

      this.onPositionstateChange = this._onPositionstateChange.bind(this);
      this.onPlaybackstateChange = this._onPlaybackstateChange.bind(this);
      this.onSupportedKeysChange = this._onSupportedKeysChange.bind(this);
      this.onMetadataChange = this._onMetadataChange.bind(this);
      this.onDeactivated = this._onDeactivated.bind(this);
      this.onPipModeChange = this._onPictureInPictureModeChange.bind(this);

      this.#initEventListeners();

      let leaveTimeout;
      this.mediaControlsContainer.addEventListener('mouseenter', (event) => {
        clearTimeout(leaveTimeout);
        event.target.classList.add('hover');
      });

      this.mediaControlsContainer.addEventListener('mouseleave', (event) => {
        leaveTimeout = setTimeout(() => {
          event.target.classList.remove('hover');
        }, 100);
      });

      setInterval(() => {
        for (const [_, controls] of this._mediaControllers) {
          if (controls.controller?.isPlaying) {
            let positionState = this._positionStates[controls.browser.browsingContext.id];
            if (positionState.position >= positionState.duration) continue;

            const incrementBy = (performance.now() - this._lastUpdatedPositionTime) / 1_000;
            positionState.position += incrementBy * positionState.playbackRate;

            controls.mediaProgressBar.value =
              (positionState.position / positionState.duration) * 100;
            controls.mediaCurrentTime.textContent = this.formatSecondsToTime(
              positionState.position
            );
          }
        }

        this._lastUpdatedPositionTime = performance.now();
      }, 1_000);
    }

    #initEventListeners() {
      this.mediaControlsContainer.addEventListener('mousedown', (event) => {
        if (event.target.closest(':is(toolbarbutton,#zen-media-progress-hbox)')) return;
        else {
          const mediaControls = event.target.closest('#zen-media-controls-toolbar');
          if (!mediaControls) return;

          const browsingContextId = Number.parseInt(
            mediaControls.getAttribute('browsingContextId')
          );
          const controls = this._mediaControllers.get(browsingContextId);

          this.onMediaFocus(controls);
        }
      });

      this.mediaControlsContainer.addEventListener('command', (event) => {
        const button = event.target.closest('toolbarbutton');
        if (!button) return;

        const mediaControls = button.closest('#zen-media-controls-toolbar');
        if (!mediaControls) return;

        const browsingContextId = Number.parseInt(mediaControls.getAttribute('browsingContextId'));
        const controls = this._mediaControllers.get(browsingContextId);

        switch (button.id) {
          case 'zen-media-pip-button':
            this.onMediaPip(controls);
            break;
          case 'zen-media-close-button':
            this.onControllerClose(controls);
            break;
          case 'zen-media-focus-button':
            this.onMediaFocus(controls);
            break;
          case 'zen-media-mute-button':
            this.onMediaMute(controls);
            break;
          case 'zen-media-previoustrack-button':
            this.onMediaPlayPrev(controls);
            break;
          case 'zen-media-nexttrack-button':
            this.onMediaPlayNext(controls);
            break;
          case 'zen-media-playpause-button':
            this.onMediaToggle(controls);
            break;
          case 'zen-media-mute-mic-button':
            this.onMicrophoneMuteToggle(controls);
            break;
          case 'zen-media-mute-camera-button':
            this.onCameraMuteToggle(controls);
            break;
        }
      });

      window.addEventListener('TabSelect', (event) => {
        const linkedBrowser = event.target.linkedBrowser;
        this.switchController();

        const controls = this._mediaControllers.get(linkedBrowser.browsingContext.id);
        if (controls) this.hideMediaControls(controls);

        for (const [browsingContextId, controls] of this._mediaControllers) {
          if (browsingContextId !== linkedBrowser.browsingContext.id) {
            this.showMediaControls(controls);
          }
        }
      });

      const onTabDiscardedOrClosed = this.onTabDiscardedOrClosed.bind(this);

      window.addEventListener('TabClose', onTabDiscardedOrClosed);
      window.addEventListener('TabBrowserDiscarded', onTabDiscardedOrClosed);

      window.addEventListener('DOMAudioPlaybackStarted', (event) => {
        this.activateMediaControls(event.target.browsingContext.mediaController, event.target);
      });

      window.addEventListener('DOMAudioPlaybackStopped', (event) =>
        this.updateMuteState(event.target.browsingContext.id)
      );
    }

    onTabDiscardedOrClosed(event) {
      this.deinitMediaController(
        this._mediaControllers.get(event.target.linkedBrowser.browsingContext.id)
      );
    }

    deinitMediaController(controls) {
      if (!controls) return;
      if (controls.controller) {
        controls.controller.removeEventListener('pictureinpicturemodechange', this.onPipModeChange);
        controls.controller.removeEventListener('positionstatechange', this.onPositionstateChange);
        controls.controller.removeEventListener('playbackstatechange', this.onPlaybackstateChange);
        controls.controller.removeEventListener('supportedkeyschange', this.onSupportedKeysChange);
        controls.controller.removeEventListener('metadatachange', this.onMetadataChange);
        controls.controller.removeEventListener('deactivated', this.onDeactivated);

        controls.mediaProgressBar.removeEventListener('input', this.onMediaSeekDrag.bind(this));
        controls.mediaProgressBar.removeEventListener(
          'change',
          this.onMediaSeekComplete.bind(this)
        );
      }

      controls.mediaControlsElement.remove();
      this._mediaControllers.delete(controls.browser.browsingContext.id);

      gZenUIManager.updateTabsToolbar();
      gZenUIManager.restoreScrollbarState();
    }

    hideMediaControls(controls) {
      if (controls.mediaControlsElement.hasAttribute('hidden')) return;

      return gZenUIManager.motion
        .animate(
          controls.mediaControlsElement,
          {
            opacity: [1, 0],
            y: [0, 10],
          },
          {
            duration: 0.1,
          }
        )
        .then(() => {
          controls.mediaControlsElement.setAttribute('hidden', 'true');
          controls.mediaControlsElement.removeAttribute('media-sharing');
          gZenUIManager.updateTabsToolbar();
        });
    }

    showMediaControls(controls) {
      if (!controls.mediaControlsElement.hasAttribute('hidden')) return;
      if (!controls.isSharing) {
        if (controls.controller.isBeingUsedInPIPModeOrFullscreen)
          return this.hideMediaControls(controls);
        this.updatePipButton(controls.browser.browsingContext.id);
      }

      const mediaInfoElements = [controls.mediaTitle, controls.mediaArtist];
      for (const element of mediaInfoElements) {
        element.removeAttribute('overflow'); // So we can properly recalculate the overflow
      }

      controls.mediaControlsElement.removeAttribute('hidden');
      window.requestAnimationFrame(() => {
        controls.mediaControlsElement.style.height =
          controls.mediaControlsElement.querySelector('toolbaritem').getBoundingClientRect()
            .height + 'px';
        controls.mediaControlsElement.style.opacity = 0;
        gZenUIManager.updateTabsToolbar();
        gZenUIManager.motion.animate(
          controls.mediaControlsElement,
          {
            opacity: [0, 1],
            y: [10, 0],
          },
          {}
        );
        this.addLabelOverflows(mediaInfoElements);
      });
    }

    addLabelOverflows(elements) {
      for (const element of elements) {
        const parent = element.parentElement;
        if (element.scrollWidth > parent.clientWidth) {
          element.setAttribute('overflow', '');
        } else {
          element.removeAttribute('overflow');
        }
      }
    }

    setupMediaControlUI(browsingContextId) {
      const { controller, browser, mediaControlsElement, positionState, mediaTitle, mediaArtist } =
        this._mediaControllers.get(browsingContextId);

      this.updatePipButton(browsingContextId);

      mediaControlsElement.classList.toggle('playing', controller.isPlaying);

      const metadata = controller.getMetadata();
      mediaTitle.textContent = metadata.title;
      mediaArtist.textContent = metadata.artist;

      const iconURL = browser.mIconURL || `page-icon:${browser.currentURI.spec}`;
      mediaControlsElement.querySelector('#zen-media-focus-button').style.listStyleImage =
        `url(${iconURL})`;

      gZenUIManager.updateTabsToolbar();

      this.updateMediaPosition(browsingContextId, positionState);

      for (const key of this.supportedKeys) {
        const button = mediaControlsElement.querySelector(`#zen-media-${key}-button`);
        button.disabled = !controller.supportedKeys.includes(key);
      }
    }

    activateMediaControls(mediaController, browser) {
      this.switchController();

      if (!mediaController.isActive) return;
      const { browsingContext } = browser;

      if (this._mediaControllers.has(browsingContext.id)) return;

      const mediaControls = this.cloneMediaControls(browsingContext.id);
      const mediaProgressBar = mediaControls.querySelector('#zen-media-progress-bar');

      mediaProgressBar.addEventListener('input', this.onMediaSeekDrag.bind(this));
      mediaProgressBar.addEventListener('change', this.onMediaSeekComplete.bind(this));

      const positionState = mediaController.getPositionState();

      this._mediaControllers.set(browsingContext.id, {
        browser,
        positionState: {
          ...positionState,
          lastUpdated: Date.now(),
        },
        controller: mediaController,
        mediaControlsElement: mediaControls,
        mediaTitle: mediaControls.querySelector('#zen-media-title'),
        mediaArtist: mediaControls.querySelector('#zen-media-artist'),
        mediaDuration: mediaControls.querySelector('#zen-media-duration'),
        mediaCurrentTime: mediaControls.querySelector('#zen-media-current-time'),
        mediaProgressBar: mediaControls.querySelector('#zen-media-progress-bar'),
      });

      this._positionStates[browsingContext.id] = positionState;
      this.updatePipButton(browsingContext.id);

      mediaController.addEventListener('pictureinpicturemodechange', this.onPipModeChange);
      mediaController.addEventListener('positionstatechange', this.onPositionstateChange);
      mediaController.addEventListener('playbackstatechange', this.onPlaybackstateChange);
      mediaController.addEventListener('supportedkeyschange', this.onSupportedKeysChange);
      mediaController.addEventListener('metadatachange', this.onMetadataChange);
      mediaController.addEventListener('deactivated', this.onDeactivated);

      this.setupMediaControlUI(browsingContext.id);
    }

    activateMediaDeviceControls(browser) {
      if (browser?.browsingContext.currentWindowGlobal.hasActivePeerConnections()) {
        const mediaControls = this.cloneMediaControls(browser.browsingContext.id);

        const tab = window.gBrowser.getTabForBrowser(browser);
        const iconURL = browser.mIconURL || `page-icon:${browser.currentURI.spec}`;

        mediaControls.setAttribute('media-sharing', '');

        mediaControls.querySelector('#zen-media-focus-button').style.listStyleImage =
          `url(${iconURL})`;
        mediaControls.querySelector('#zen-media-artist').mediaArtist.textContent = '';
        mediaControls.querySelector('#zen-media-title').textContent = tab.label;

        const controls = { browser, mediaControlsElement: mediaControls };

        this._mediaControllers.set(browser.browsingContext.id, controls);
        this.showMediaControls(controls);
      }
    }

    cloneMediaControls(browsingContextId) {
      const mediaControlsClone = this.mediaControlsTemplate.cloneNode(true);
      mediaControlsClone.setAttribute('id', 'zen-media-controls-toolbar');
      mediaControlsClone.setAttribute('browsingContextId', browsingContextId);
      mediaControlsClone.style.setProperty('--index', this._mediaControllers.size);

      this.mediaControlsContainer.prepend(mediaControlsClone);
      return this.mediaControlsContainer.querySelector(
        `[browsingContextId="${browsingContextId}"]`
      );
    }

    updateMediaSharing(data) {
      return console.error('TODO: updateMediaSharing');

      const { windowId, showCameraIndicator, showMicrophoneIndicator } = data;

      for (const browser of window.gBrowser.browsers) {
        const isMatch = browser.innerWindowID === windowId;
        const isCurrentBrowser = this._currentBrowser?.browserId === browser.browserId;
        const shouldShow = showCameraIndicator || showMicrophoneIndicator;

        if (!isMatch) continue;
        if (shouldShow && !(isCurrentBrowser && this.isSharing)) {
          const webRTC = browser.browsingContext.currentWindowGlobal.getActor('WebRTC');
          webRTC.sendAsyncMessage('webrtc:UnmuteMicrophone');
          webRTC.sendAsyncMessage('webrtc:UnmuteCamera');

          if (this._currentBrowser) this.isSharing = false;
          if (this._currentMediaController) {
            this._currentMediaController.pause();
            this.deinitMediaController(this._currentMediaController).then(() =>
              this.activateMediaDeviceControls(browser)
            );
          } else this.activateMediaDeviceControls(browser);
        } else if (!shouldShow && isCurrentBrowser && this.isSharing) {
          this.isSharing = false;
          this._currentBrowser = null;
          this.hideMediaControls();
        }

        break;
      }
    }

    _onDeactivated(event) {
      this.deinitMediaController(event.target);
      this.switchController();
    }

    _onPlaybackstateChange(event) {
      const mediaController = this._mediaControllers.get(event.target.id);
      mediaController.mediaControlsElement.classList.toggle(
        'playing',
        mediaController.controller.isPlaying
      );

      this.switchController();
    }

    _onSupportedKeysChange(event) {
      const mediaController = this._mediaControllers.get(event.target.id);
      for (const key of this.supportedKeys) {
        const button = mediaController.mediaControlsElement.querySelector(
          `#zen-media-${key}-button`
        );
        button.disabled = !event.target.supportedKeys.includes(key);
      }
    }

    _onPositionstateChange(event) {
      const mediaController = this._mediaControllers.get(event.target.id);
      const positionState = {
        position: event.position,
        duration: event.duration,
        playbackRate: event.playbackRate,
        lastUpdated: Date.now(),
      };

      this._mediaControllers.set(event.target.id, {
        ...mediaController,
        positionState,
      });

      this._positionStates[event.target.id] = positionState;
      this.updateMediaPosition(event.target.id, event);
    }

    switchController() {}

    updateMediaPosition(browsingContextId, positionState) {
      const { mediaCurrentTime, mediaDuration, mediaProgressBar, mediaControlsElement } =
        this._mediaControllers.get(browsingContextId);
      const { position, duration } = positionState;

      if (duration >= 900_000)
        return mediaControlsElement.setAttribute('media-position-hidden', 'true');
      else mediaControlsElement.removeAttribute('media-position-hidden');

      mediaCurrentTime.textContent = this.formatSecondsToTime(position);
      mediaProgressBar.value = (position / duration) * 100;
      mediaDuration.textContent = this.formatSecondsToTime(duration);
    }

    formatSecondsToTime(seconds) {
      if (!seconds || isNaN(seconds)) return '0:00';

      const totalSeconds = Math.max(0, Math.ceil(seconds));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60).toString();
      const secs = (totalSeconds % 60).toString();

      if (hours > 0) {
        return `${hours}:${minutes.padStart(2, '0')}:${secs.padStart(2, '0')}`;
      }

      return `${minutes}:${secs.padStart(2, '0')}`;
    }

    _onMetadataChange(event) {
      const controls = this._mediaControllers.get(event.target.id);
      this.updatePipButton(event.target.id);

      const metadata = event.target.getMetadata();
      controls.mediaTitle.textContent = metadata.title;
      controls.mediaArtist.textContent = metadata.artist;

      const mediaInfoElements = [controls.mediaTitle, controls.mediaArtist];
      for (const element of mediaInfoElements) {
        element.removeAttribute('overflow');
      }

      this.addLabelOverflows(mediaInfoElements);
    }

    _onPictureInPictureModeChange(event) {
      const controls = this._mediaControllers.get(event.target.id);

      controls.mediaControlsElement.toggleAttribute(
        'pip',
        event.target.isBeingUsedInPIPModeOrFullscreen
      );
      if (event.target.isBeingUsedInPIPModeOrFullscreen) this.hideMediaControls(controls);
      else {
        const { selectedBrowser } = window.gBrowser;
        if (selectedBrowser.browserId !== controls.browser.browserId) {
          this.showMediaControls(controls);
        }
      }
    }

    onMediaPlayPrev(mediaControls) {
      if (mediaControls.controller.supportedKeys.includes('previoustrack'))
        mediaControls.controller.prevTrack();
    }

    onMediaPlayNext(mediaControls) {
      if (mediaControls.controller.supportedKeys.includes('nexttrack'))
        mediaControls.controller.nextTrack();
    }

    onMediaSeekDrag(event) {
      const mediaControls = event.target.closest('#zen-media-controls-toolbar');
      const controls = this._mediaControllers.get(
        Number.parseInt(mediaControls.getAttribute('browsingContextId'))
      );

      controls.controller.pause();
      event.target.closest('#zen-media-current-time').textContent = this.formatSecondsToTime(
        (event.target.value / 100) * controls.positionState.duration
      );
    }

    onMediaSeekComplete(event) {
      const mediaControls = event.target.closest('#zen-media-controls-toolbar');
      const controls = this._mediaControllers.get(
        Number.parseInt(mediaControls.getAttribute('browsingContextId'))
      );

      const newPosition = (event.target.value / 100) * controls.positionState.duration;
      if (controls.controller.supportedKeys.includes('seekto')) {
        controls.controller.seekTo(newPosition);
        controls.controller.play();
      }
    }

    onMediaFocus(mediaControls) {
      if (mediaControls.controller) mediaControls.controller.focus();
      else {
        const tab = window.gBrowser.getTabForBrowser(mediaControls.browser);
        if (tab) window.ZenWorkspaces.switchTabIfNeeded(tab);
      }
    }

    onMediaMute(mediaControls) {
      const muted = mediaControls.mediaControlsElement.toggleAttribute('muted');

      if (muted) mediaControls.browser.mute();
      else mediaControls.browser.unmute();
    }

    onMediaToggle(mediaControls) {
      if (mediaControls.mediaControlsElement.classList.contains('playing'))
        mediaControls.controller.pause();
      else mediaControls.controller.play();
    }

    onControllerClose(mediaControls) {
      const controller = mediaControls.controller;
      controller?.stop(), this.deinitMediaController(mediaControls);

      if (this.isSharing) this.isSharing = false;
      this.switchController();
    }

    onMediaPip(mediaControls) {
      mediaControls.browser.browsingContext.currentWindowGlobal
        .getActor('PictureInPictureLauncher')
        .sendAsyncMessage('PictureInPicture:KeyToggle');
    }

    onMicrophoneMuteToggle(mediaControls) {
      const shouldMute = mediaControls.mediaControlsElement.hasAttribute('mic-muted')
        ? 'webrtc:UnmuteMicrophone'
        : 'webrtc:MuteMicrophone';

      mediaControls.browser.browsingContext.currentWindowGlobal
        .getActor('WebRTC')
        .sendAsyncMessage(shouldMute);
      mediaControls.mediaControlsElement.toggleAttribute('mic-muted');
    }

    onCameraMuteToggle(mediaControls) {
      const shouldMute = mediaControls.mediaControlsElement.hasAttribute('camera-muted')
        ? 'webrtc:UnmuteCamera'
        : 'webrtc:MuteCamera';

      mediaControls.browser.browsingContext.currentWindowGlobal
        .getActor('WebRTC')
        .sendAsyncMessage(shouldMute);
      mediaControls.mediaControlsElement.toggleAttribute('camera-muted');
    }

    updateMuteState(browsingContextId) {
      const mediaControls = this._mediaControllers.get(browsingContextId);
      mediaControls.mediaControlsElement.toggleAttribute(
        'muted',
        mediaControls.browser._audioMuted
      );
    }

    updatePipButton(browsingContextId) {
      const mediaControls = this._mediaControllers.get(browsingContextId);

      const { totalPipCount, totalPipDisabled } = PictureInPicture.getEligiblePipVideoCount(
        mediaControls.browser
      );
      const canPip = totalPipCount === 1 || (totalPipDisabled > 0 && lazy.RESPECT_PIP_DISABLED);

      mediaControls.mediaControlsElement.toggleAttribute('can-pip', canPip);
    }
  }

  window.gZenMediaController = new nsZenMediaController();
}
