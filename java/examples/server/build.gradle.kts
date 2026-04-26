plugins {
    application
    java
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(17)
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("dev.realmid:sdk:0.1.0")
}

application {
    mainClass.set("dev.realmid.example.Server")
}
