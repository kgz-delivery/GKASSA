plugins {
    id("com.android.application")
}

android {
    namespace = "kg.flash.paymentreader"
    compileSdk = 37

    defaultConfig {
        applicationId = "kg.flash.paymentreader"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.work:work-runtime-ktx:2.10.5")
    testImplementation("junit:junit:4.13.2")
}
