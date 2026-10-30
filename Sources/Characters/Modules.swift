/// The characters' native modules compiled into the app: each registers the acts its scripts cannot express (see
/// CharacterKit). A character whose states are all scripts needs no module, just its package
/// (characters/<id>/: character.json, states/, assets/). The system calls registerAll() once at launch.
enum CharacterModules {
    static func registerAll() {
        Dynames.register()
    }
}
