import { arrayIntercalate } from "collection-utils";

import { Type, ClassProperty, ClassType, ObjectType } from "../Type";
import { matchType, directlyReachableSingleNamedType } from "../TypeUtils";
import {
    utf16LegalizeCharacters,
    utf16StringEscape,
    splitIntoWords,
    combineWords,
    firstUpperWordStyle,
    allUpperWordStyle,
    camelCase
} from "../support/Strings";
import { panic } from "../support/Support";

import { Sourcelike, modifySource } from "../Source";
import { Namer, Name } from "../Naming";
import { ConvenienceRenderer } from "../ConvenienceRenderer";
import { TargetLanguage } from "../TargetLanguage";
import { BooleanOption, Option, OptionValues, getOptionValues } from "../RendererOptions";
import { RenderContext } from "../Renderer";

const unicode = require("unicode-properties");

export const javaScriptOptions = {
    runtimeTypecheck: new BooleanOption("runtime-typecheck", "Verify JSON.parse results at runtime", true)
};

export type JavaScriptTypeAnnotations = {
    any: string;
    anyArray: string;
    anyMap: string;
    string: string;
    stringArray: string;
    boolean: string;
    never: string;
};

export class JavaScriptTargetLanguage extends TargetLanguage {
    constructor(
        displayName: string = "JavaScript",
        names: string[] = ["javascript", "js", "jsx"],
        extension: string = "js"
    ) {
        super(displayName, names, extension);
    }

    protected getOptions(): Option<any>[] {
        return [javaScriptOptions.runtimeTypecheck];
    }

    get supportsOptionalClassProperties(): boolean {
        return true;
    }

    get supportsFullObjectType(): boolean {
        return true;
    }

    protected makeRenderer(
        renderContext: RenderContext,
        untypedOptionValues: { [name: string]: any }
    ): JavaScriptRenderer {
        return new JavaScriptRenderer(this, renderContext, getOptionValues(javaScriptOptions, untypedOptionValues));
    }
}

function isStartCharacter(utf16Unit: number): boolean {
    return unicode.isAlphabetic(utf16Unit) || utf16Unit === 0x5f; // underscore
}

function isPartCharacter(utf16Unit: number): boolean {
    const category: string = unicode.getCategory(utf16Unit);
    return ["Nd", "Pc", "Mn", "Mc"].indexOf(category) >= 0 || isStartCharacter(utf16Unit);
}

const legalizeName = utf16LegalizeCharacters(isPartCharacter);

function typeNameStyle(original: string): string {
    const words = splitIntoWords(original);
    return combineWords(
        words,
        legalizeName,
        firstUpperWordStyle,
        firstUpperWordStyle,
        allUpperWordStyle,
        allUpperWordStyle,
        "",
        isStartCharacter
    );
}

function propertyNameStyle(original: string): string {
    const escaped = utf16StringEscape(original);
    const quoted = `"${escaped}"`;

    if (original.length === 0) {
        return quoted;
    } else if (!isStartCharacter(original.codePointAt(0) as number)) {
        return quoted;
    } else if (escaped !== original) {
        return quoted;
    } else if (legalizeName(original) !== original) {
        return quoted;
    } else {
        return original;
    }
}

export class JavaScriptRenderer extends ConvenienceRenderer {
    constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _jsOptions: OptionValues<typeof javaScriptOptions>
    ) {
        super(targetLanguage, renderContext);
    }

    protected makeNamedTypeNamer(): Namer {
        return new Namer("types", typeNameStyle, []);
    }

    protected namerForObjectProperty(): Namer {
        return new Namer("properties", propertyNameStyle, []);
    }

    protected makeUnionMemberNamer(): null {
        return null;
    }

    protected makeEnumCaseNamer(): Namer {
        return new Namer("enum-cases", typeNameStyle, []);
    }

    protected namedTypeToNameForTopLevel(type: Type): Type | undefined {
        return directlyReachableSingleNamedType(type);
    }

    protected makeNameForProperty(
        c: ClassType,
        className: Name,
        p: ClassProperty,
        jsonName: string,
        _assignedName: string | undefined
    ): Name | undefined {
        // Ignore the assigned name
        return super.makeNameForProperty(c, className, p, jsonName, undefined);
    }

    protected emitDescriptionBlock(lines: string[]): void {
        this.emitCommentLines(lines, " * ", "/**", " */");
    }

    typeMapTypeFor = (t: Type): Sourcelike => {
        if (["class", "object", "enum"].indexOf(t.kind) >= 0) {
            return ['r("', this.nameForNamedType(t), '")'];
        }
        return matchType<Sourcelike>(
            t,
            _anyType => '"any"',
            _nullType => `null`,
            _boolType => `true`,
            _integerType => `0`,
            _doubleType => `3.14`,
            _stringType => `""`,
            arrayType => ["a(", this.typeMapTypeFor(arrayType.items), ")"],
            _classType => panic("We handled this above"),
            mapType => ["m(", this.typeMapTypeFor(mapType.values), ")"],
            _enumType => panic("We handled this above"),
            unionType => {
                const children = Array.from(unionType.getChildren()).map(this.typeMapTypeFor);
                return ["u(", ...arrayIntercalate(", ", children), ")"];
            }
        );
    };

    typeMapTypeForProperty(p: ClassProperty): Sourcelike {
        const typeMap = this.typeMapTypeFor(p.type);
        if (!p.isOptional) {
            return typeMap;
        }
        return ["u(undefined, ", typeMap, ")"];
    }

    emitBlock(source: Sourcelike, end: Sourcelike, emit: () => void) {
        this.emitLine(source, "{");
        this.indent(emit);
        this.emitLine("}", end);
    }

    emitTypeMap = () => {
        const { any: anyAnnotation } = this.typeAnnotations;

        this.emitBlock(`const typeMap${anyAnnotation} = `, ";", () => {
            this.forEachObject("none", (t: ObjectType, name: Name) => {
                const additionalProperties = t.getAdditionalProperties();
                const additional =
                    additionalProperties !== undefined ? this.typeMapTypeFor(additionalProperties) : "false";
                this.emitBlock(['"', name, '": o('], [", ", additional, "),"], () => {
                    this.forEachClassProperty(t, "none", (propName, _propJsonName, property) => {
                        this.emitLine(propName, ": ", this.typeMapTypeForProperty(property), ",");
                    });
                });
            });
            this.forEachEnum("none", (e, name) => {
                this.emitLine('"', name, '": [');
                this.indent(() => {
                    this.forEachEnumCase(e, "none", (_caseName, jsonName) => {
                        this.emitLine(`"${utf16StringEscape(jsonName)}",`);
                    });
                });
                this.emitLine("],");
            });
        });
    };

    protected deserializerFunctionName(name: Name): Sourcelike {
        return ["to", name];
    }

    protected deserializerFunctionLine(_t: Type, name: Name): Sourcelike {
        return ["function ", this.deserializerFunctionName(name), "(json)"];
    }

    protected serializerFunctionName(name: Name): Sourcelike {
        const camelCaseName = modifySource(camelCase, name);
        return [camelCaseName, "ToJson"];
    }

    protected serializerFunctionLine(_t: Type, name: Name): Sourcelike {
        return ["function ", this.serializerFunctionName(name), "(value)"];
    }

    protected get moduleLine(): string | undefined {
        return undefined;
    }

    protected get castFunctionLine(): string {
        return "function cast(val, typ)";
    }

    protected get typeAnnotations(): JavaScriptTypeAnnotations {
        return { any: "", anyArray: "", anyMap: "", string: "", stringArray: "", boolean: "", never: "" };
    }

    private emitConvertModuleBody(): void {
        this.forEachTopLevel("interposing", (t, name) => {
            this.emitBlock([this.deserializerFunctionLine(t, name), " "], "", () => {
                if (!this._jsOptions.runtimeTypecheck) {
                    this.emitLine("return JSON.parse(json);");
                } else {
                    this.emitLine("return cast(JSON.parse(json), ", this.typeMapTypeFor(t), ");");
                }
            });
            this.ensureBlankLine();

            this.emitBlock([this.serializerFunctionLine(t, name), " "], "", () => {
                this.emitLine("return JSON.stringify(value, null, 2);");
            });
        });
        if (this._jsOptions.runtimeTypecheck) {
            const {
                any: anyAnnotation,
                anyArray: anyArrayAnnotation,
                anyMap: anyMapAnnotation,
                string: stringAnnotation,
                stringArray: stringArrayAnnotation,
                never: neverAnnotation
            } = this.typeAnnotations;
            this.ensureBlankLine();
            this.emitMultiline(`function invalidValue(typ${anyAnnotation}, val${anyAnnotation})${neverAnnotation} {
    throw Error(\`Invalid value \${JSON.stringify(val)} for type \${JSON.stringify(typ)}\`);
}

${this.castFunctionLine} {
    if (typ === "any") return val;
    if (typ === null) {
        if (val === null) return val;
        return invalidValue(typ, val);
    }
    if (typ === false) return invalidValue(typ, val);
    while (typeof typ === "object" && typ.ref !== undefined) {
        typ = typeMap[typ.ref];
    }
    if (Array.isArray(typ)) return transformEnum(typ, val);
    if (typeof typ === "object") {
        return typ.hasOwnProperty("unionMembers") ? transformUnion(typ.unionMembers, val)
            : typ.hasOwnProperty("arrayItems")    ? transformArray(typ.arrayItems, val)
            : typ.hasOwnProperty("props")         ? transformObject(typ.props, typ.additional, val)
            : invalidValue(typ, val);
    }
    return transformPrimitive(typ, val);
}

function transformPrimitive(typ${stringAnnotation}, val${anyAnnotation})${anyAnnotation} {
    if (typeof typ === typeof val) return val;
    return invalidValue(typ, val);
}

function transformUnion(typs${anyArrayAnnotation}, val${anyAnnotation})${anyAnnotation} {
    // val must validate against one typ in typs
    var l = typs.length;
    for (var i = 0; i < l; i++) {
        var typ = typs[i];
        try {
            return cast(val, typ);
        } catch (_) {}
    }
    return invalidValue(typs, val);
}

function transformEnum(cases${stringArrayAnnotation}, val${anyAnnotation})${anyAnnotation} {
    if (cases.indexOf(val) !== -1) return val;
    return invalidValue(cases, val);
}

function transformArray(typ${anyAnnotation}, val${anyAnnotation})${anyAnnotation} {
    // val must be an array with no invalid elements
    if (!Array.isArray(val)) return invalidValue("array", val);
    return val.map(el => cast(el, typ));
}

function transformObject(props${anyMapAnnotation}, additional${anyAnnotation}, val${anyAnnotation})${anyAnnotation} {
    if (val === null || typeof val !== "object" || Array.isArray(val)) {
        return invalidValue("object", val);
    }
    var result = {};
    Object.getOwnPropertyNames(val).forEach(key => {
        const prop = val[key];
        if (Object.prototype.hasOwnProperty.call(props, key)) {
            result[key] = cast(prop, props[key]);
        } else {
            result[key] = cast(prop, additional);
        }
    });
    return result;
}

function a(typ${anyAnnotation}) {
    return { arrayItems: typ };
}

function u(...typs${anyArrayAnnotation}) {
    return { unionMembers: typs };
}

function o(props${anyMapAnnotation}, additional${anyAnnotation}) {
    return { props, additional };
}

function m(additional${anyAnnotation}) {
    return { props: {}, additional };
}

function r(name${stringAnnotation}) {
    return { ref: name };
}
`);
            this.emitTypeMap();
        }
    }

    protected emitConvertModule(): void {
        this.ensureBlankLine();
        this.emitMultiline(`// Converts JSON strings to/from your types`);
        if (this._jsOptions.runtimeTypecheck) {
            this.emitMultiline(`// and asserts the results of JSON.parse at runtime`);
        }
        const moduleLine = this.moduleLine;
        if (moduleLine === undefined) {
            this.emitConvertModuleBody();
        } else {
            this.emitBlock([moduleLine, " "], "", () => this.emitConvertModuleBody());
        }
    }

    protected emitTypes(): void {
        return;
    }

    protected emitUsageImportComment(): void {
        this.emitLine('//   const Convert = require("./file");');
    }

    protected emitUsageComments(): void {
        this.emitMultiline(`// To parse this data:
//`);

        this.emitUsageImportComment();
        this.emitLine("//");
        this.forEachTopLevel("none", (_t, name) => {
            const camelCaseName = modifySource(camelCase, name);
            this.emitLine("//   const ", camelCaseName, " = Convert.to", name, "(json);");
        });
        if (this._jsOptions.runtimeTypecheck) {
            this.emitLine("//");
            this.emitLine("// These functions will throw an error if the JSON doesn't");
            this.emitLine("// match the expected interface, even if the JSON is valid.");
        }
    }

    protected emitModuleExports(): void {
        this.ensureBlankLine();

        this.emitBlock("module.exports = ", ";", () => {
            this.forEachTopLevel("none", (_, name) => {
                const serializer = this.serializerFunctionName(name);
                const deserializer = this.deserializerFunctionName(name);
                this.emitLine('"', serializer, '": ', serializer, ",");
                this.emitLine('"', deserializer, '": ', deserializer, ",");
            });
        });
    }

    protected emitSourceStructure() {
        if (this.leadingComments !== undefined) {
            this.emitCommentLines(this.leadingComments);
        } else {
            this.emitUsageComments();
        }

        this.emitTypes();

        this.emitConvertModule();

        this.emitModuleExports();
    }
}
