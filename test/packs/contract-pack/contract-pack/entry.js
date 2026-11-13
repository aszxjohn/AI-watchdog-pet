// The contract test pack's entry, written to character pack API v1.0
// (docs/pack-api-v1.md). It is a classic script: the stage evaluates it and
// takes the value of its last expression, the factory below, then calls it
// once with `stage`. The handlers it returns are keyed by message type; what
// `frame` returns is that tick's draw, `{ [actorId]: commands[] }`, which the
// Worker bootstrap wraps with `type: 'draw'` and the frame's `seq`.
//
// Time comes only from `frame.t` and random numbers only from
// `stage.random(actorId)`; nothing here touches any other global.

// no-unused-expressions is off for the one statement below: the stage uses
// its value (the script's completion value), which the rule cannot see.
// oxlint-disable-next-line no-unused-expressions
(function createContractPack(stage) {
  'use strict';

  /**
   * This pack's actors by actorId: character, full parameter values,
   * latest state and display name. Keyed by actorId, never by characterId:
   * one character may have several actors at once.
   */
  const actors = new Map();

  function remember(actor) {
    actors.set(actor.actorId, {
      characterId: actor.characterId,
      params: actor.params,
      state: actor.state,
      displayName: actor.displayName,
      // Where in its blink cycle the actor starts, 0 to 1 (probe-two).
      blinkPhase: stage.random(actor.actorId),
    });
  }

  /** probe-one: one image, stretched to 60 x 110 base pixels. */
  function drawProbeOne(actorId, actor, t) {
    const lift =
      actor.state === 'working'
        ? Math.abs(Math.sin(t / 250)) * actor.params.bob
        : 0;
    const commands = [
      {
        type: 'sprite',
        asset: actor.params.skin,
        x: -30,
        y: -110 - lift,
        scaleX: 30,
        scaleY: 55,
        alpha: actor.state === 'waiting' ? 0.7 : 1,
      },
    ];
    if (actor.state === 'thinking' && actor.params.glow) {
      commands.push({
        type: 'particles',
        emitterId: 'glow',
        preset: 'sparkle',
        x: (stage.random(actorId) - 0.5) * 6,
        y: -120,
      });
    }
    return commands;
  }

  /** probe-two: a two-frame spritesheet, stretched to 50 x 96. */
  function drawProbeTwo(actorId, actor, t) {
    const period = actor.params['blink-every'] * 1000;
    const blinking = (t + actor.blinkPhase * period) % period < 150;
    const sprite = {
      type: 'sprite',
      asset: 'probe-two-sheet',
      frame: blinking ? 'eyes-shut' : 'eyes-open',
      x: -25,
      y: -96,
      scaleX: 25,
      scaleY: 48,
    };
    if (actor.params.mood === 'busy') {
      sprite.rotation = Math.sin(t / 120) * 0.08;
    }
    if (actor.state === 'error') {
      sprite.alpha = 0.5;
    }
    return [sprite];
  }

  const drawers = new Map([
    ['probe-one', drawProbeOne],
    ['probe-two', drawProbeTwo],
  ]);

  return {
    init(message) {
      actors.clear();
      for (const actor of message.actors) {
        // Another pack's actor: only its id and its state as of now.
        if (actor.own) {
          remember(actor);
        }
      }
    },

    spawn(message) {
      remember(message);
    },

    despawn(message) {
      actors.delete(message.actorId);
    },

    params(message) {
      for (const actor of actors.values()) {
        if (actor.characterId === message.characterId) {
          actor.params = message.params;
        }
      }
    },

    meta(message) {
      const actor = actors.get(message.actorId);
      if (actor !== undefined) {
        actor.displayName = message.displayName;
      }
    },

    frame(message) {
      const draw = {};
      for (const { actorId, state } of message.actors) {
        const actor = actors.get(actorId);
        if (actor === undefined) {
          continue;
        }
        actor.state = state;
        const drawActor = drawers.get(actor.characterId);
        draw[actorId] =
          drawActor === undefined ? [] : drawActor(actorId, actor, message.t);
      }
      return draw;
    },
  };
});
