<template>
    <!-- Выбор файлов - панель той же анатомии, что файл над ней: имя в шапке,
         действие справа от имени, поля внутри. Кнопка названа тем же словом,
         что панель, поэтому ясно, что именно она сохраняет -->
    <section class="panel">
        <div class="panel-bar">
            <h2 class="panel-title"><InterfaceIcon name="sliders" />{{ $t("fileSelection") }}</h2>
            <button class="btn btn-sm btn-primary" :disabled="disabled || !changed" @click="save">
                <font-awesome-icon icon="save" />{{ $t("saveFileSelection") }}
            </button>
        </div>

        <div class="panel-body fields">
            <div v-if="inventory.needsComposeSelection" class="alert alert-warning" role="alert">
                <font-awesome-icon icon="triangle-exclamation" />
                {{ $t("needsComposeSelection") }}
            </div>

            <!-- Compose file used for every docker compose call -->
            <div class="field">
                <label class="form-label" for="compose-file-select">{{ $t("composeFile") }}</label>
                <select id="compose-file-select" v-model="config.composeFileName" class="form-select" :disabled="disabled">
                    <option v-for="fileName in inventory.composeFileNames" :key="fileName" :value="fileName">
                        {{ fileName }}
                    </option>
                </select>
                <div class="form-text">{{ $t("composeFileHint") }}</div>
            </div>

            <!-- Ordered env files passed to compose for interpolation -->
            <div class="field">
                <span class="form-label">{{ $t("envFiles") }}</span>
                <div v-if="inventory.envFileNames.length === 0" class="form-text">{{ $t("noEnvFiles") }}</div>

                <!-- Отмеченные файлы стоят первыми, в том порядке, в каком уходят
                     в compose; остальные каталога - под тонкой линией. Без нее скачок
                     строки вверх при отметке выглядел бы произвольной перестановкой -->
                <ul v-else class="file-list">
                    <li
                        v-for="fileName in orderedEnvFileNames"
                        :key="fileName"
                        class="file-row"
                        :class="{ rest: fileName === firstRestFileName }"
                    >
                        <div class="form-check">
                            <input
                                :id="`env-file-${fileName}`"
                                class="form-check-input"
                                type="checkbox"
                                :checked="config.envFileNames.includes(fileName)"
                                :disabled="disabled"
                                @change="toggleEnvFile(fileName)"
                            />
                            <label class="form-check-label" :for="`env-file-${fileName}`">{{ fileName }}</label>
                        </div>

                        <!-- Порядок показывается и двигается только когда файлов больше
                             одного: на единственном файле стрелки все равно никуда не
                             ведут, а выключенная пара кнопок в строке - шум -->
                        <div v-if="orderVisible && config.envFileNames.includes(fileName)" class="order-group">
                            <span class="order">{{ envIndex(fileName) + 1 }}</span>
                            <div class="btn-group btn-group-sm">
                                <button
                                    class="btn btn-normal"
                                    :disabled="disabled || envIndex(fileName) === 0"
                                    :title="$t('moveUp')"
                                    @click="moveEnvFile(fileName, -1)"
                                >
                                    <font-awesome-icon icon="chevron-up" />
                                </button>
                                <button
                                    class="btn btn-normal"
                                    :disabled="disabled || envIndex(fileName) === config.envFileNames.length - 1"
                                    :title="$t('moveDown')"
                                    @click="moveEnvFile(fileName, 1)"
                                >
                                    <font-awesome-icon icon="chevron-down" />
                                </button>
                            </div>
                        </div>
                    </li>
                </ul>
                <div class="form-text">{{ $t("envFilesHint") }}</div>
            </div>

            <!-- Новый env-файл заводится здесь же, где выбираются остальные: файл
                 появляется пустым и ничего больше не трогает. Отметить его и открыть
                 в редакторе - отдельные шаги, иначе выбор менялся бы под уже открытым
                 текстом и сохранение записало бы старое содержимое в новый файл -->
            <div class="field">
                <div class="add-row">
                    <input
                        v-model="newEnvFileName"
                        class="form-control"
                        placeholder=".env.prod"
                        :aria-label="$t('addEnvFile')"
                        :disabled="disabled || changed"
                        @keyup.enter="createEnvFile"
                    />
                    <button class="btn btn-sm btn-normal" :disabled="disabled || changed || !canCreateEnvFile" @click="createEnvFile">
                        <font-awesome-icon icon="plus" />{{ $t("addEnvFile") }}
                    </button>
                </div>
                <div class="form-text">{{ addEnvFileMessage }}</div>
            </div>

            <!-- Env file shown in the editor -->
            <div v-if="inventory.envFileNames.length > 0" class="field">
                <label class="form-label" for="active-env-select">{{ $t("activeEnvFile") }}</label>
                <select id="active-env-select" v-model="config.activeEnvFileName" class="form-select" :disabled="disabled">
                    <option value="">{{ $t("none") }}</option>
                    <option v-for="fileName in inventory.envFileNames" :key="fileName" :value="fileName">
                        {{ fileName }}
                    </option>
                </select>
                <div class="form-text">{{ $t("activeEnvFileHint") }}</div>
            </div>

            <!-- Файл лежит в каталоге, но список имен его не принял. Молча пропасть он
                 не может: на диске он виден, а экран, не упоминающий его ни словом,
                 читается как потеря файла. Здесь он - только текст: выбрать его нельзя,
                 пока имя не переименовано в разрешенные знаки -->
            <div v-if="unsupportedFileNames.length > 0" class="field">
                <span class="form-label">{{ $t("unsupportedFiles") }}</span>
                <ul class="file-list">
                    <li v-for="fileName in unsupportedFileNames" :key="fileName" class="file-row refused">
                        <span class="refused-name">{{ fileName }}</span>
                    </li>
                </ul>
                <div class="form-text">{{ $t("unsupportedFilesHint") }}</div>
            </div>
        </div>
    </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from "vue";
import InterfaceIcon from "./InterfaceIcon.vue";
import { isEnvFileName } from "../../../common/stack-files";
import type { StackFileConfig, StackFileInventory } from "../../../common/types/stack";

/**
 * Copy a config so editing does not mutate the inventory
 * @param config Config to copy
 * @returns Copy
 */
function copyConfig(config : StackFileConfig) : StackFileConfig {
    return {
        composeFileName: config.composeFileName,
        envFileNames: [ ...config.envFileNames ],
        activeEnvFileName: config.activeEnvFileName,
        secretBindings: config.secretBindings.map(binding => ({
            name: binding.name,
            fileName: binding.fileName,
            services: [ ...binding.services ],
        })),
    };
}

export default defineComponent({
    components: {
        InterfaceIcon,
    },
    props: {
        /** Inventory returned by the getStackFiles event */
        inventory: {
            type: Object as PropType<StackFileInventory>,
            required: true,
        },
        disabled: {
            type: Boolean,
            default: false,
        },
    },
    emits: [ "save", "create-env" ],
    data() {
        return {
            config: copyConfig(this.inventory.config),
            newEnvFileName: "",
        };
    },
    computed: {
        /** Selected files first, in their configured order, then the remaining ones */
        orderedEnvFileNames() : string[] {
            const selected = this.config.envFileNames.filter(name => this.inventory.envFileNames.includes(name));
            const rest = this.inventory.envFileNames.filter(name => !selected.includes(name));
            return [ ...selected, ...rest ];
        },

        /**
         * Порядок важен только когда файлов в подстановке больше одного
         * @returns Показывать ли номер и стрелки
         */
        orderVisible() : boolean {
            return this.config.envFileNames.length > 1;
        },

        /**
         * Первый файл каталога, оставшийся без отметки: с него начинается остаток списка
         * @returns Имя файла, пустая строка, когда линию рисовать не над чем
         */
        firstRestFileName() : string {
            if (this.config.envFileNames.length === 0) {
                return "";
            }

            return this.orderedEnvFileNames.find(name => !this.config.envFileNames.includes(name)) ?? "";
        },

        /**
         * Файлы каталога, отброшенные списком имен
         * @returns Имена; пусто, когда агент отвечает старым инвентарем
         */
        unsupportedFileNames() : string[] {
            return this.inventory.unsupportedFileNames ?? [];
        },

        changed() : boolean {
            return JSON.stringify(this.config) !== JSON.stringify(this.cloneConfig(this.inventory.config));
        },

        /**
         * Whether the typed name can become a new env file
         * @returns True when the name is accepted and free
         */
        canCreateEnvFile() : boolean {
            const fileName = this.newEnvFileName.trim();
            return fileName !== "" && isEnvFileName(fileName) && !this.inventory.envFileNames.includes(fileName);
        },

        /**
         * One line under the field that always says what is going on: why the form is
         * closed, why the name is refused, or what happens after the file appears
         * @returns Message
         */
        addEnvFileMessage() : string {
            const fileName = this.newEnvFileName.trim();

            if (this.changed) {
                return this.$t("saveFileSelectionFirst");
            }

            if (fileName !== "" && !isEnvFileName(fileName)) {
                return this.$t("envFileNameHint");
            }

            if (fileName !== "" && this.inventory.envFileNames.includes(fileName)) {
                return this.$t("envFileNameTaken");
            }

            return this.$t("addEnvFileHint");
        },
    },
    watch: {
        inventory: {
            deep: true,
            handler() {
                this.config = this.cloneConfig(this.inventory.config);
            },
        },
    },
    methods: {
        /**
         * Copy a config so editing does not mutate the inventory
         * @param config Config to copy
         * @returns Copy
         */
        cloneConfig(config : StackFileConfig) : StackFileConfig {
            return copyConfig(config);
        },

        /**
         * Position of an env file in the interpolation order
         * @param fileName Env file
         * @returns Index, -1 when the file is not selected
         */
        envIndex(fileName : string) {
            return this.config.envFileNames.indexOf(fileName);
        },

        /**
         * Add or remove an env file from the interpolation set
         * @param fileName Env file
         */
        toggleEnvFile(fileName : string) {
            const index = this.envIndex(fileName);

            if (index === -1) {
                this.config.envFileNames.push(fileName);
            } else {
                this.config.envFileNames.splice(index, 1);

                if (this.config.activeEnvFileName === fileName) {
                    this.config.activeEnvFileName = this.config.envFileNames[0] ?? "";
                }
            }
        },

        /**
         * Move an env file in the interpolation order
         * @param fileName Env file
         * @param offset -1 to move up, 1 to move down
         */
        moveEnvFile(fileName : string, offset : number) {
            const index = this.envIndex(fileName);
            const target = index + offset;

            if (index === -1 || target < 0 || target >= this.config.envFileNames.length) {
                return;
            }

            const [ moved ] = this.config.envFileNames.splice(index, 1);
            if (moved === undefined) {
                return;
            }
            this.config.envFileNames.splice(target, 0, moved);
        },

        /** Ask the page to create the typed env file */
        createEnvFile() {
            if (!this.canCreateEnvFile || this.disabled || this.changed) {
                return;
            }

            this.$emit("create-env", this.newEnvFileName.trim());
            this.newEnvFileName = "";
        },

        save() {
            this.$emit("save", this.cloneConfig(this.config));
        },
    },
});
</script>

<style scoped lang="scss">
// Поля стоят колонкой с одним шагом; подпись поля и подсказка под ним - без
// собственных полей, расстояние дает колонка
.fields {
    display: flex;
    flex-direction: column;
    gap: var(--gap-md);
}

.field {
    display: flex;
    flex-direction: column;
    gap: var(--gap-xs);
}

.form-label {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
}

.form-text {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-faint);
}

.alert {
    margin: 0;
}

.file-list {
    list-style: none;
    padding: 0;
    margin: 0;
}

.file-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap-md);
    min-height: var(--control-height);
}

// Граница между отмеченными файлами и остальными файлами каталога
.file-row.rest {
    margin-top: var(--gap-xs);
    padding-top: var(--gap-xs);
    border-top: 1px solid var(--line-hair);
}

// Номер и стрелки - одна группа: номер говорит, что двигают кнопки рядом
.order-group {
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
}

.order {
    min-width: 1ch;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-faint);
    text-align: right;
}

// Отброшенное имя не притворяется выбором: ни флажка, ни кнопок, только имя.
// Высота строки управления такой строке не нужна - нажимать в ней нечего
.file-row.refused {
    min-height: 0;
    padding: 2px 0;
}

.refused-name {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--text-muted);
}

// Имя нового файла и кнопка - одна строка, как у секрета в соседней панели;
// на узкой колонке кнопка уходит под поле, а не сжимает его до пары букв
.add-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--gap-sm);

    .form-control {
        flex: 1 1 12ch;
        min-width: 0;
        font-family: var(--font-mono);
    }

    .btn {
        flex: none;
    }
}
</style>
